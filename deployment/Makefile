# (SO9169)
# Before starting deployment process please update the following variables.
# ENV - unique variable that indicates the environment name. Global resources created, such as S3 buckets, use this name. (ex: devx)
# PRIMARY_REGION - AWS region that will serve as primary for the workload
# SECONDARY_REGION - AWS region that will serve as the failover region for the workload
# DOMAIN_NAME - the Route53 private hosted zone domain name that should be created for this workload

ENV=-dev
PRIMARY_REGION=us-east-1
SECONDARY_REGION=us-west-2
SES_IDENTITY=sender@example.com
EMPTY_LIST='{ "Objects": null }'
.DEFAULT_GOAL := test-creds
MAKE=/usr/bin/make

WITNESS_REGION=us-east-2
NAMING_PREFIX=BatchFailover

global:
	@echo "Deploying global infrastructure Cloudformation stack..."
	@aws cloudformation deploy --stack-name global-base$(ENV) --region $(PRIMARY_REGION) --template-file globalResources.yml --capabilities CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND --parameter-overrides PrimaryRegion=$(PRIMARY_REGION) SecondaryRegion=$(SECONDARY_REGION) Env=$(ENV) --no-fail-on-empty-changeset
	@echo "Finished global infrastructure stack"

active-region-table:
	@echo "Deploying ActiveRegion DynamoDB Global Table..."
	@aws cloudformation deploy --stack-name active-region-table$(ENV) --region $(PRIMARY_REGION) --template-file database/dynamodb/active-region-table.yml --parameter-overrides NamingPrefix=$(NAMING_PREFIX) Env=$(ENV) PrimaryRegion=$(PRIMARY_REGION) SecondaryRegion=$(SECONDARY_REGION) WitnessRegion=$(WITNESS_REGION) --no-fail-on-empty-changeset
	@echo "Finished ActiveRegion table stack"

init-active-region: active-region-table
	@echo "Seeding initial Active Region record..."
	@aws dynamodb put-item --table-name $(NAMING_PREFIX)ActiveRegion$(ENV) --region $(PRIMARY_REGION) --item '{"pk":{"S":"ACTIVE_REGION"},"region":{"S":"$(PRIMARY_REGION)"},"updatedAt":{"S":"'$$(date -u +%Y-%m-%dT%H:%M:%SZ)'"},"updatedBy":{"S":"initial-deployment"}}'
	@echo "Active Region record seeded with region=$(PRIMARY_REGION)"

primary-vpc:
	@echo "Installing resources into primary region..."
	@echo "Deploying VPC infrastructure Cloudformation stack..."
	@aws cloudformation deploy --stack-name regionalVPC$(ENV) --capabilities CAPABILITY_IAM --region $(PRIMARY_REGION) --template-file regionalVpc.yml --parameter-overrides Env=$(ENV) --no-fail-on-empty-changeset

primary-app: global-routing
	@echo "Building and Deploying Application..."
	sam build -t ./samTemplate.yaml --use-container
	sam deploy --resolve-s3 --stack-name batch$(ENV) --capabilities CAPABILITY_IAM --region $(PRIMARY_REGION) --no-confirm-changeset --no-fail-on-empty-changeset --parameter-overrides "Env=$(ENV)" "SESSender=$(SES_IDENTITY)" "SESRecipient=$(SES_IDENTITY)" "SESIdentityName=$(SES_IDENTITY)" "SourceBucket=$(shell aws cloudformation list-stack-resources --region $(PRIMARY_REGION) --stack-name regionalVPC$(ENV) --query "StackResourceSummaries[?LogicalResourceId=='SourceBucket'].{PhysicalResourceId: PhysicalResourceId}" --output text)" --disable-rollback

secondary-app: primary-app
	@echo "Building and Deploying Application to secondary region..."
	sam deploy --resolve-s3 --stack-name batch$(ENV) --capabilities CAPABILITY_IAM --region $(SECONDARY_REGION) --no-confirm-changeset --no-fail-on-empty-changeset --parameter-overrides "Env=$(ENV)" "SESSender=$(SES_IDENTITY)" "SESRecipient=$(SES_IDENTITY)" "SESIdentityName=$(SES_IDENTITY)" "SourceBucket=$(shell aws cloudformation list-stack-resources --region $(SECONDARY_REGION) --stack-name regionalVPC$(ENV) --query "StackResourceSummaries[?LogicalResourceId=='SourceBucket'].{PhysicalResourceId: PhysicalResourceId}" --output text)" --disable-rollback

secondary-vpc:
	@echo "Installing resources into secondary region..."
	@echo "Deploying VPC infrastructure Cloudformation stack..."
	@aws cloudformation deploy --stack-name regionalVPC$(ENV) --capabilities CAPABILITY_IAM --region $(SECONDARY_REGION) --template-file regionalVpc.yml --parameter-overrides Env=$(ENV) --no-fail-on-empty-changeset

global-routing: primary-vpc secondary-vpc
	@echo "Deploying global routing resources..."
	@aws cloudformation deploy --stack-name global-routing$(ENV) --region $(PRIMARY_REGION) --template-file globalRouting.yml --capabilities CAPABILITY_IAM --parameter-overrides Env=$(ENV) PrimaryRegion=$(PRIMARY_REGION) SecondaryRegion=$(SECONDARY_REGION) PrimaryRegionBucketSecretName=SourceBucket-$(PRIMARY_REGION)$(ENV) SecondaryRegionBucketSecretName=SourceBucket-$(SECONDARY_REGION)$(ENV) --no-fail-on-empty-changeset

dashboard: primary-app secondary-app
	@echo "Deploying dashboard..."
	@aws cloudformation deploy --stack-name dashboard$(ENV) --region $(PRIMARY_REGION) --template-file dashboard-template.yml --capabilities CAPABILITY_IAM --parameter-overrides Env=$(ENV) PrimaryRegion=$(PRIMARY_REGION) SecondaryRegion=$(SECONDARY_REGION) --no-fail-on-empty-changeset
	@echo "Deploy Complete!"

chaos-primary:
	@echo "Deploying Chaos Testing resources in Primary Region..."
	@aws cloudformation deploy --stack-name chaos$(ENV) --region $(PRIMARY_REGION) --template-file fisTemplate.yml --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset
	@echo "Deploy Complete in Primary Region!"

chaos-secondary:
	@echo "Deploying Chaos Testing resources in Secondary Region..."
	@aws cloudformation deploy --stack-name chaos$(ENV) --region $(SECONDARY_REGION) --template-file fisTemplate.yml --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset
	@echo "Deploy Complete in Secondary Region!"

failover-plan: active-region-table
	@echo "Deploying ARC Region Switch Plan..."
	@aws cloudformation deploy --stack-name failover-plan$(ENV) --region $(PRIMARY_REGION) --template-file failover.yaml --capabilities CAPABILITY_NAMED_IAM --parameter-overrides Env=$(ENV) NamingPrefix=$(NAMING_PREFIX) PrimaryRegion=$(PRIMARY_REGION) SecondaryRegion=$(SECONDARY_REGION) --no-fail-on-empty-changeset
	@echo "Finished ARC Region Switch Plan stack"

ngrh: dashboard failover-plan
	@echo "Deploying NGRH Resilience Model..."
	$(eval APP_ARN_PRIMARY := $(shell aws cloudformation describe-stacks --region $(PRIMARY_REGION) --stack-name batch$(ENV) --query "Stacks[0].StackId" --output text))
	$(eval APP_ARN_STANDBY := $(shell aws cloudformation describe-stacks --region $(SECONDARY_REGION) --stack-name batch$(ENV) --query "Stacks[0].StackId" --output text))
	$(eval GLOBAL_BASE_ARN := $(shell aws cloudformation describe-stacks --region $(PRIMARY_REGION) --stack-name global-base$(ENV) --query "Stacks[0].StackId" --output text))
	$(eval GLOBAL_ROUTING_ARN := $(shell aws cloudformation describe-stacks --region $(PRIMARY_REGION) --stack-name global-routing$(ENV) --query "Stacks[0].StackId" --output text))
	$(eval VPC_ARN_PRIMARY := $(shell aws cloudformation describe-stacks --region $(PRIMARY_REGION) --stack-name regionalVPC$(ENV) --query "Stacks[0].StackId" --output text))
	$(eval VPC_ARN_STANDBY := $(shell aws cloudformation describe-stacks --region $(SECONDARY_REGION) --stack-name regionalVPC$(ENV) --query "Stacks[0].StackId" --output text))
	$(eval ACTIVE_REGION_TABLE_ARN := $(shell aws cloudformation describe-stacks --region $(PRIMARY_REGION) --stack-name active-region-table$(ENV) --query "Stacks[0].StackId" --output text))
	$(eval FAILOVER_PLAN_ARN := $(shell aws cloudformation describe-stacks --region $(PRIMARY_REGION) --stack-name failover-plan$(ENV) --query "Stacks[0].StackId" --output text))
	@aws cloudformation deploy \
		--stack-name ngrh-ngrh$(ENV) \
		--region $(PRIMARY_REGION) \
		--template-file ngrh.yaml \
		--capabilities CAPABILITY_NAMED_IAM \
		--parameter-overrides \
			Env=$(ENV) \
			PrimaryRegion=$(PRIMARY_REGION) \
			StandbyRegion=$(SECONDARY_REGION) \
			AppArnPrimary=$(APP_ARN_PRIMARY) \
			AppArnStandby=$(APP_ARN_STANDBY) \
			GlobalBaseArn=$(GLOBAL_BASE_ARN) \
			GlobalRoutingArn=$(GLOBAL_ROUTING_ARN) \
			VpcArnPrimary=$(VPC_ARN_PRIMARY) \
			VpcArnStandby=$(VPC_ARN_STANDBY) \
			ActiveRegionTableArn=$(ACTIVE_REGION_TABLE_ARN) \
			FailoverPlanArn=$(FAILOVER_PLAN_ARN) \
		--no-fail-on-empty-changeset || \
	(echo "NGRH deploy failed (known CFN defect). Cleaning up and retrying..." && \
		aws cloudformation delete-stack --stack-name ngrh-ngrh$(ENV) --region $(PRIMARY_REGION) && \
		aws cloudformation wait stack-delete-complete --stack-name ngrh-ngrh$(ENV) --region $(PRIMARY_REGION) && \
		aws cloudformation deploy \
			--stack-name ngrh-ngrh$(ENV) \
			--region $(PRIMARY_REGION) \
			--template-file ngrh.yaml \
			--capabilities CAPABILITY_NAMED_IAM \
			--parameter-overrides \
				Env=$(ENV) \
				PrimaryRegion=$(PRIMARY_REGION) \
				StandbyRegion=$(SECONDARY_REGION) \
				AppArnPrimary=$(APP_ARN_PRIMARY) \
				AppArnStandby=$(APP_ARN_STANDBY) \
				GlobalBaseArn=$(GLOBAL_BASE_ARN) \
				GlobalRoutingArn=$(GLOBAL_ROUTING_ARN) \
				VpcArnPrimary=$(VPC_ARN_PRIMARY) \
				VpcArnStandby=$(VPC_ARN_STANDBY) \
				ActiveRegionTableArn=$(ACTIVE_REGION_TABLE_ARN) \
				FailoverPlanArn=$(FAILOVER_PLAN_ARN) \
			--no-fail-on-empty-changeset)
	@echo "NGRH model deployed!"

ngrh-assess:
	@echo "Waiting for NGRH resource discovery to complete..."
	$(eval SERVICE_ARNS := $(shell aws cloudformation describe-stacks --region $(PRIMARY_REGION) --stack-name ngrh-ngrh$(ENV) --query "Stacks[0].Outputs[?OutputKey=='ServiceArns'].OutputValue" --output text))
	@for svc_arn in $$(echo "$(SERVICE_ARNS)" | tr ',' ' '); do \
		svc_name=$$(echo "$$svc_arn" | grep -oP '(?<=service/)[^/]+'); \
		echo "Checking resource discovery for $$svc_name..."; \
		attempts=0; \
		while [ $$attempts -lt 80 ]; do \
			count=$$(aws resiliencehubv2 list-resources --region $(PRIMARY_REGION) --service-arn "$$svc_arn" --query "length(serviceResources)" --output text 2>/dev/null | awk '{s+=$$1} END{print s+0}'); \
			if [ "$$count" -gt 0 ]; then \
				echo "  $$svc_name: $$count resources discovered"; \
				break; \
			fi; \
			attempts=$$((attempts + 1)); \
			sleep 15; \
		done; \
		if [ $$attempts -ge 80 ]; then \
			echo "  WARNING: $$svc_name resource discovery timed out (20 min)"; \
		fi; \
	done
	@echo ""
	@echo "Starting failure mode assessments..."
	@for svc_arn in $$(echo "$(SERVICE_ARNS)" | tr ',' ' '); do \
		svc_name=$$(echo "$$svc_arn" | grep -oP '(?<=service/)[^/]+'); \
		echo "  Assessing $$svc_name..."; \
		aws resiliencehubv2 start-failure-mode-assessment --region $(PRIMARY_REGION) --service-arn "$$svc_arn" --no-cli-pager 2>&1 | head -3; \
	done
	@echo "Assessments started! Results available in ~10-15 minutes."

destroy-ngrh:
	@echo "Destroying NGRH stack..."
	$(eval NGRH_BUCKET := $(shell aws cloudformation describe-stacks --region $(PRIMARY_REGION) --stack-name ngrh-ngrh$(ENV) --query "Stacks[0].Outputs[?OutputKey=='NgrhBucketName'].OutputValue" --output text 2>/dev/null))
	@if [ -n "$(NGRH_BUCKET)" ] && [ "$(NGRH_BUCKET)" != "None" ]; then \
		echo "Emptying NGRH bucket $(NGRH_BUCKET)..."; \
		./cleanup.sh $(NGRH_BUCKET); \
	fi
	@aws cloudformation delete-stack --stack-name ngrh-ngrh$(ENV) --region $(PRIMARY_REGION)
	@aws cloudformation wait stack-delete-complete --stack-name ngrh-ngrh$(ENV) --region $(PRIMARY_REGION)
	@echo "NGRH stack destroyed!"

deploy: test-creds global active-region-table init-active-region primary-vpc secondary-vpc global-routing primary-app secondary-app failover-plan dashboard ngrh

chaos: test-creds chaos-primary chaos-secondary

destroy-chaos:
	@echo "Removing Chaos Resources..."
	@aws cloudformation delete-stack --stack-name chaos$(ENV) --region $(PRIMARY_REGION)
	@aws cloudformation wait stack-delete-complete --stack-name chaos$(ENV) --region $(PRIMARY_REGION)
	@echo "Destroyed Chaos Resources in Primary Region!"

	@aws cloudformation delete-stack --stack-name chaos$(ENV) --region $(SECONDARY_REGION)
	@aws cloudformation wait stack-delete-complete --stack-name chaos$(ENV) --region $(SECONDARY_REGION)
	@echo "Destroyed Chaos Resources in Secondary Region!"

destroy-all:
	@echo "Removing all cloudformation stacks!!"
	@echo ""
	@echo "=== Phase 0: Remove NGRH model (depends on all other stacks) ==="
	@-$(MAKE) destroy-ngrh 2>/dev/null || true
	@echo ""
	@echo "=== Phase 1: Remove application stacks (depend on secrets from routing/VPC stacks) ==="
	@echo "Disabling DynamoDB deletion protection (required before stack delete)..."
	@-for region in $(SECONDARY_REGION) $(PRIMARY_REGION); do \
		for table in $$(aws cloudformation list-stack-resources --region $$region --stack-name batch$(ENV) \
			--query "StackResourceSummaries[?ResourceType=='AWS::DynamoDB::Table'].PhysicalResourceId" \
			--output text 2>/dev/null); do \
			aws dynamodb update-table --region $$region --table-name "$$table" \
				--no-deletion-protection-enabled --no-cli-pager 2>/dev/null || true; \
		done; \
	done
	@echo "Removing application from secondary region..."
	@-sam delete --stack-name batch$(ENV) --region $(SECONDARY_REGION) --no-prompts
	@echo "Removing application from primary region..."
	@-sam delete --stack-name batch$(ENV) --region $(PRIMARY_REGION) --no-prompts

	@echo "Cleaning up orphaned log groups (created by scheduled Lambda invocations during deletion)..."
	@-aws logs delete-log-group --log-group-name /aws/lambda/$(NAMING_PREFIX)ActiveRegionMonitor$(ENV) --region $(PRIMARY_REGION) 2>/dev/null || true
	@-aws logs delete-log-group --log-group-name /aws/lambda/$(NAMING_PREFIX)ActiveRegionMonitor$(ENV) --region $(SECONDARY_REGION) 2>/dev/null || true

	@echo ""
	@echo "=== Phase 2: Remove dashboard and failover plan ==="
	@aws cloudformation delete-stack --stack-name dashboard$(ENV) --region $(PRIMARY_REGION)
	@-aws cloudformation wait stack-delete-complete --stack-name dashboard$(ENV) --region $(PRIMARY_REGION)
	@aws cloudformation delete-stack --stack-name failover-plan$(ENV) --region $(PRIMARY_REGION)
	@-aws cloudformation wait stack-delete-complete --stack-name failover-plan$(ENV) --region $(PRIMARY_REGION)

	@echo ""
	@echo "=== Phase 3: Remove global routing (owns SourceBucketMRAPSecret, replication config) ==="
	@aws cloudformation delete-stack --stack-name global-routing$(ENV) --region $(PRIMARY_REGION)
	@aws cloudformation wait stack-delete-complete --stack-name global-routing$(ENV) --region $(PRIMARY_REGION)

	@echo ""
	@echo "=== Phase 4: Remove primary regional VPC stack (empty buckets, then delete) ==="
	@echo "Waiting 60s for Lambda ENIs to detach from VPC subnets..."
	@sleep 60
	$(eval result:=$(shell aws cloudformation list-stack-resources --region $(PRIMARY_REGION) --stack-name regionalVPC$(ENV) --query "StackResourceSummaries[?LogicalResourceId=='SourceBucket'].{PhysicalResourceId: PhysicalResourceId}" --output text 2>/dev/null | cut -d: -f6 ))
	@-./cleanup.sh $(result)
	$(eval result:=$(shell aws cloudformation list-stack-resources --region $(PRIMARY_REGION) --stack-name regionalVPC$(ENV) --query "StackResourceSummaries[?LogicalResourceId=='LoggingBucket'].{PhysicalResourceId: PhysicalResourceId}" --output text 2>/dev/null | cut -d: -f6 ))
	@-./cleanup.sh $(result)
	@aws cloudformation delete-stack --stack-name regionalVPC$(ENV) --region $(PRIMARY_REGION)
	@aws cloudformation wait stack-delete-complete --stack-name regionalVPC$(ENV) --region $(PRIMARY_REGION) || \
		(echo "Retry: waiting 120s for ENI cleanup..." && sleep 120 && \
		aws cloudformation delete-stack --stack-name regionalVPC$(ENV) --region $(PRIMARY_REGION) && \
		aws cloudformation wait stack-delete-complete --stack-name regionalVPC$(ENV) --region $(PRIMARY_REGION))

	@echo ""
	@echo "=== Phase 5: Remove secondary regional VPC stack (empty buckets, then delete) ==="
	$(eval result:=$(shell aws cloudformation list-stack-resources --region $(SECONDARY_REGION) --stack-name regionalVPC$(ENV) --query "StackResourceSummaries[?LogicalResourceId=='SourceBucket'].{PhysicalResourceId: PhysicalResourceId}" --output text 2>/dev/null | cut -d: -f6 ))
	@-./cleanup.sh $(result)
	$(eval result:=$(shell aws cloudformation list-stack-resources --region $(SECONDARY_REGION) --stack-name regionalVPC$(ENV) --query "StackResourceSummaries[?LogicalResourceId=='LoggingBucket'].{PhysicalResourceId: PhysicalResourceId}" --output text 2>/dev/null | cut -d: -f6 ))
	@-./cleanup.sh $(result)
	@aws cloudformation delete-stack --stack-name regionalVPC$(ENV) --region $(SECONDARY_REGION)
	@aws cloudformation wait stack-delete-complete --stack-name regionalVPC$(ENV) --region $(SECONDARY_REGION) || \
		(echo "Retry: waiting 120s for ENI cleanup..." && sleep 120 && \
		aws cloudformation delete-stack --stack-name regionalVPC$(ENV) --region $(SECONDARY_REGION) && \
		aws cloudformation wait stack-delete-complete --stack-name regionalVPC$(ENV) --region $(SECONDARY_REGION))

	@echo ""
	@echo "=== Phase 6: Remove shared infrastructure ==="
	@echo "Removing ActiveRegion table..."
	@aws cloudformation delete-stack --stack-name active-region-table$(ENV) --region $(PRIMARY_REGION)
	@aws cloudformation wait stack-delete-complete --stack-name active-region-table$(ENV) --region $(PRIMARY_REGION)
	@echo "Removing global stack..."
	@aws cloudformation delete-stack --stack-name global-base$(ENV) --region $(PRIMARY_REGION)
	@aws cloudformation wait stack-delete-complete --stack-name global-base$(ENV) --region $(PRIMARY_REGION)

clean:
	@echo "To remove all stacks deployed by this solution, run 'make destroy-all'"

test-creds:
	@echo "Current AWS session:"
	@aws sts get-caller-identity