# FIS Resilience Test Analysis Report

## Architecture Summary

This is a multi-region serverless batch processing application deployed across us-east-1 (primary) and us-west-2 (secondary) with active/passive failover.

**Infrastructure discovered across 7 CloudFormation/SAM templates:**

| Resource Type | Count | Templates |
|---|---|---|
| Lambda Functions | 14 | samTemplate.yaml |
| DynamoDB Global Tables | 2 | globalResources.yml, active-region-table.yml |
| DynamoDB Tables (regional) | 2 | samTemplate.yaml (FinancialTable, ErrorTable) |
| S3 Buckets | 2 per region | regionalVpc.yml (SourceBucket, LoggingBucket) |
| S3 MRAP | 1 | globalRouting.yml |
| Step Functions | 3 | samTemplate.yaml |
| API Gateway | 1 | samTemplate.yaml |
| VPC + 3 Subnets | 1 per region | regionalVpc.yml |
| VPC Endpoints | 5 per region | regionalVpc.yml (S3, DynamoDB, SFN, SMTP, SecretsManager, API GW) |
| ARC Region Switch Plan | 1 | failover.yaml |
| Existing FIS Template | 1 | fisTemplate.yml (network disruption only) |

**Critical path:** S3 upload → S3NotificationLambda → MainOrchestrator SFN → SplitFile → ProcessChunk SFN (Map) → ValidateData → GetData (API GW) → WriteOutputChunk → MergeFiles → SendEmail

**Failover path:** ARC Region Switch Plan → RegionWriter (updates DynamoDB) + MrapRouting (updates S3 MRAP) → ReconciliationTrigger → DelayedReconciliation SFN

**Existing resilience mechanisms:**
- Multi-region deployment (us-east-1 / us-west-2)
- DynamoDB Global Tables (BatchStateTable with eventual consistency, ActiveRegionTable with MRSC)
- S3 cross-region replication via MRAP
- ARC Region Switch Plan for orchestrated failover
- Step Functions retry policies on all Lambda invocations
- RegionWriter and MrapRouting have application-level retries (3 attempts with exponential backoff)
- ActiveRegionMonitor publishes health metrics every minute
- VPC-attached Lambdas with private subnets across 3 AZs

---

## Recommended FIS Experiments

### HIGH PRIORITY — Validate existing failover mechanisms

#### 1. S3 MRAP Replication Pause
- **FIS Action:** `aws:s3:bucket-pause-replication`
- **Target:** SourceBucket in primary region (regionalvpc-dev-sourcebucket-*)
- **Hypothesis:** When S3 replication is paused, new files uploaded to primary are not replicated to secondary. After failover, the reconciliation process (DelayedReconciliation SFN) detects and re-processes unreconciled files.
- **Steady state:** Files uploaded to primary appear in secondary within 15 minutes
- **Stop conditions:** CloudWatch alarm on S3 replication latency > 30 minutes, or Step Functions execution failures > 5
- **Blast radius:** Cross-region replication only — primary region processing unaffected
- **Risk level:** Medium — tests a core resilience mechanism
- **Prerequisites:** Active monitoring dashboard, files in-flight for processing
- **Why:** The reconciliation mechanism (900-second wait + copy) has never been validated under actual replication failure

#### 2. DynamoDB Global Table Replication Pause (BatchStateTable)
- **FIS Action:** `aws:dynamodb:global-table-pause-replication`
- **Target:** BatchStateTable (MREC global table from globalResources.yml)
- **Hypothesis:** When DynamoDB replication pauses, batch state records written in primary are not visible in secondary. After failover, the reconciliation function queries for INITIALIZED records and re-triggers processing.
- **Steady state:** Records written in primary appear in secondary within seconds
- **Stop conditions:** CloudWatch alarm on DynamoDB replication latency
- **Blast radius:** Cross-region data consistency
- **Risk level:** Medium
- **Prerequisites:** Active batch processing with files in INITIALIZED state
- **Note:** Subject to 5,040-minute impairment quota per 7-day rolling window
- **Why:** The reconciliation logic in `reconciliation/app.py` queries the status-index GSI for INITIALIZED records — this validates that the failover data recovery path actually works

#### 3. DynamoDB Global Table Replication Pause (ActiveRegionTable - MRSC)
- **FIS Action:** `aws:dynamodb:global-table-pause-replication`
- **Target:** BatchFailoverActiveRegion table (MRSC global table from active-region-table.yml)
- **Hypothesis:** When MRSC replication pauses, the active region record may become inconsistent across regions. The S3NotificationLambda reads this table to decide whether to process files — a stale read could cause files to be processed in the wrong region or skipped entirely.
- **Steady state:** ActiveRegion record is consistent across all regions
- **Stop conditions:** ActiveRegionDynamo CloudWatch metric diverges between regions
- **Blast radius:** Region routing decisions
- **Risk level:** High — could cause dual-processing or dropped files
- **Prerequisites:** Run in staging first. Monitor ActiveRegionDynamo metric closely.
- **Why:** This is the single most critical data point in the architecture — every S3 notification Lambda reads it to decide whether to process

#### 4. Network Disruption — VPC Connectivity (already partially implemented)
- **FIS Action:** `aws:network:disrupt-connectivity` (scope: `s3`)
- **Target:** Private subnets tagged `mr-batch-Private` in primary region
- **Hypothesis:** When S3 connectivity is disrupted in the primary region, Lambda functions that read/write S3 (SplitInputFile, ReadFile, WriteOutputChunk, MergeS3Files) fail. Step Functions retries absorb transient failures. If disruption exceeds retry budget, the batch fails and is picked up by reconciliation after failover.
- **Steady state:** Batch processing completes within normal SLA
- **Stop conditions:** Step Functions execution failures > 10
- **Blast radius:** All VPC-attached Lambdas in primary region
- **Risk level:** High — disrupts active processing
- **Prerequisites:** This experiment template already exists in fisTemplate.yml. Validate stop conditions are configured (currently set to `none` — this should be fixed).
- **Why:** The existing FIS template has `StopConditions: Source: 'none'` — this is dangerous. Add a CloudWatch alarm as a stop condition.

### MEDIUM PRIORITY — Test common failure modes on critical path

#### 5. Lambda Invocation Latency — SplitInputFileFunction
- **FIS Action:** `aws:lambda:invocation-add-delay`
- **Target:** SplitInputFileFunction
- **Hypothesis:** Adding 5-10 seconds of latency to the file splitting function causes the MainOrchestrator SFN to take longer but still complete within the 900-second Lambda timeout. Step Functions retry policy handles any timeouts.
- **Steady state:** SplitInputFile completes in < 30 seconds
- **Stop conditions:** Lambda duration > 800 seconds, SFN execution time > 2x normal
- **Blast radius:** Single Lambda function
- **Risk level:** Low
- **Prerequisites:** FIS Lambda extension layer must be added to the function
- **Note:** Requires adding the FIS managed extension as a Lambda layer

#### 6. Lambda Invocation Error — SendEmailFunction
- **FIS Action:** `aws:lambda:invocation-error`
- **Target:** SendEmailFunction
- **Hypothesis:** When SendEmail fails, the MainOrchestrator SFN retries (5 attempts, 3s interval, 2x backoff per the state machine definition). If all retries fail, the SFN execution fails but the batch data is already written to S3 and DynamoDB — no data loss occurs.
- **Steady state:** Emails sent successfully after batch processing
- **Stop conditions:** SFN execution failures > 3
- **Blast radius:** Email delivery only — data processing unaffected
- **Risk level:** Low
- **Prerequisites:** FIS Lambda extension layer on SendEmailFunction

#### 7. Lambda Invocation Error — S3NotificationLambdaFunction
- **FIS Action:** `aws:lambda:invocation-error`
- **Target:** S3NotificationLambdaFunction
- **Hypothesis:** When the S3 notification handler fails, the S3 event is lost (S3 notifications are not retried by default). Files uploaded during the failure window are not processed until manual intervention or reconciliation.
- **Steady state:** Every file upload triggers processing within 60 seconds
- **Stop conditions:** InputFilesSplit metric drops to 0 for > 5 minutes
- **Blast radius:** New file processing intake
- **Risk level:** Medium — potential for dropped files
- **Prerequisites:** FIS Lambda extension layer
- **Why:** This is a single point of failure — S3 event notifications are fire-and-forget

#### 8. API Gateway Latency via Lambda — GetDataFunction
- **FIS Action:** `aws:lambda:invocation-add-delay`
- **Target:** GetDataFunction (serves GET /financials/{uuid})
- **Hypothesis:** Adding latency to the API causes the ProcessChunk SFN's "Get Financial Data" step to slow down. Since this runs inside a Map state processing many records, the cumulative latency could cause the parent SFN to approach timeout limits.
- **Steady state:** API responds in < 1 second
- **Stop conditions:** API Gateway 5xx rate > 10%, SFN execution time > 2x normal
- **Blast radius:** All chunk processing in the Map state
- **Risk level:** Medium
- **Prerequisites:** FIS Lambda extension layer on GetDataFunction

#### 9. Network Disruption — DynamoDB Connectivity
- **FIS Action:** `aws:network:disrupt-connectivity` (scope: `dynamodb`)
- **Target:** Private subnets in primary region
- **Hypothesis:** When DynamoDB connectivity is disrupted, the S3NotificationLambda cannot read the ActiveRegion table or write to BatchStateTable. New file processing halts. The ActiveRegionMonitor cannot read the active region, causing metric gaps on the dashboard.
- **Steady state:** All DynamoDB operations succeed
- **Stop conditions:** DynamoDB throttle/error metrics spike, ActiveRegionDynamo metric goes stale
- **Blast radius:** All VPC-attached Lambdas that access DynamoDB
- **Risk level:** High
- **Prerequisites:** Ensure monitoring detects the disruption

### LOW PRIORITY — Edge cases and non-critical paths

#### 10. API-Level Throttling on IAM Role
- **FIS Action:** `aws:fis:inject-api-throttle-error`
- **Target:** IAM role used by Lambda functions (service: `ec2` for VPC operations)
- **Hypothesis:** Throttling on EC2 API calls (used for VPC ENI management) causes Lambda cold starts to fail. Warm invocations are unaffected.
- **Steady state:** Lambda cold starts complete in < 10 seconds
- **Stop conditions:** Lambda error rate > 20%
- **Blast radius:** Lambda cold starts only
- **Risk level:** Low

#### 11. VPC Endpoint Disruption — Secrets Manager
- **FIS Action:** `aws:network:disrupt-vpc-endpoint`
- **Target:** VPCEndpointForSecretsManager
- **Hypothesis:** When the Secrets Manager VPC endpoint is disrupted, Lambdas that resolve secrets at invocation time (SendEmail, S3Notification) fail. This tests whether the application caches secrets or fetches them on every invocation.
- **Steady state:** All Lambda functions can access Secrets Manager
- **Stop conditions:** Lambda error rate > 50%
- **Blast radius:** All Lambdas that access Secrets Manager
- **Risk level:** Medium
- **Prerequisites:** Understand which Lambdas fetch secrets at runtime vs. via CloudFormation resolve

---

## Resilience Gaps Identified

1. **No stop conditions on existing FIS template.** The `fisTemplate.yml` has `StopConditions: Source: 'none'`. This means the experiment runs to completion regardless of impact. Add a CloudWatch alarm (e.g., SFN execution failures) as a stop condition.

2. **S3 notification is fire-and-forget.** If S3NotificationLambdaFunction fails, the S3 event is lost. There's no dead-letter queue or retry mechanism for S3 event notifications. Consider adding an SQS queue between S3 and Lambda for durability.

3. **No circuit breaker on external calls.** The SendEmail function calls SMTP and Secrets Manager without circuit breaker patterns. Under sustained failure, retries from Step Functions will keep invoking a function that keeps failing.

4. **Reconciliation assumes secondary bucket has the file.** The reconciliation function (`reconciliation/app.py`) copies from `SECONDARY_REGION_BUCKET` — if S3 replication was paused and the file never made it to the secondary region, the reconciliation copy will fail silently (caught by bare `except`).

5. **ActiveRegionMonitor has no alerting.** It publishes metrics but there are no CloudWatch alarms defined on those metrics. A divergence between DynamoDB active region and MRAP routing would go unnoticed.

6. **Regional DynamoDB tables (FinancialTable, ErrorTable) are not global.** These are single-region tables. After failover, the secondary region has no access to financial data or error records from the primary region's processing.
