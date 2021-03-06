const appsHandler = require('../util/apis/veracode/applications');
const sandboxHandler = require('../util/apis/veracode/sandboxes');
const buildInfoHandler = require('../util/apis/veracode/buildInfo');
const buildSummaryHandler = require('../util/apis/veracode/buildSummary');

const checkRun = require('../util/apis/github/checkRun');

const jsonUtil = require('../util/helper/jsonUtil');

const AWS = require('aws-sdk');

const AWS_ACCOUNT = process.env.ACCOUNT_ID;
const AWS_REGION = process.env.TARGET_REGION;

// Set the region
AWS.config.update({region: AWS_REGION});

const RECHECK_ACTION = {
	STOP : -1,
	ERROR: -2,
	SCANNING: 25,
	FINISHED: -10,
	AWAITING_POLICY_CALCULATION: 20,
	LONGER_WAIT: 60,
	SHORTER_WAIT: 30
}

// Create an SQS service object
var sqs = new AWS.SQS({apiVersion: '2012-11-05'});

const SCAN_CHECK_QUEUE_URL = `https://sqs.${AWS_REGION}.amazonaws.com/${AWS_ACCOUNT}/ScanChecks`;

const handleEvent = async (customEvent) => {
	console.log('handleEvent - START');
    const records = customEvent.Records;
	if (records.length>1) {
		console.log('Got more than one message!!!');
	}
	for (let record of records) {
		const eventAttrs = record.messageAttributes;
		const recordBody = JSON.parse(record.body);
		console.log(recordBody);
		if (recordBody.github_event === 'check_run') {
			console.log(`Error - wrong place to handle this type of event`);
			continue;
		}

		if (!eventAttrs.appLegacyID) {
			// need to collect information from the veracode platform before processing
			await firstIterationHandling(recordBody,eventAttrs);
		} else {
			// process the record
			await ongoingIterationHandling(recordBody,eventAttrs);
		}
	}
	console.log('handleEvent - END')
}

const ongoingIterationHandling = async (recordBody,eventAttrs) => {
	console.log('Starting to check for build info');
	// we can start the check of the build status
	const buildInfo = await getLatestBuildStatus(eventAttrs);

	let scanRecheckTime = RECHECK_ACTION.STOP;
	if (buildInfo['$'] && buildInfo.analysis_unit ) {
		scanRecheckTime = calculateRescanTimeFromAnalysisUnit(buildInfo.analysis_unit);
		// update with build id if not exist
		if (!eventAttrs.buildID) {
			eventAttrs.buildID = {
				dataType: "String",
				stringValue: buildInfo['$'].build_id
			}
			// update the external ID
			//const checkRunID = eventAttrs.checkRunID.stringValue;
			await checkRun.updateCheckRun(
				recordBody.repository_owner_login,
				recordBody.repository_name,
				recordBody.check_run_id
				,{
					external_id: `${eventAttrs.appGUID.stringValue}:${eventAttrs.sandboxGUID?eventAttrs.sandboxGUID.stringValue:'policy'}:${eventAttrs.buildID.stringValue}`
				}
			);
		}
	}

	if (scanRecheckTime === RECHECK_ACTION.STOP) {

		await checkRun.updateCheckRun(
			recordBody.repository_owner_login,
			recordBody.repository_name,
			recordBody.check_run_id,
			{
				status: 'completed',
				conclusion: checkRun.CONCLUSION.SKIPPED,
				output: {
					summary: 'Issue with calculating recheck time. Bailing out!',
					title: checkRun.CHECK_RESULT_TITLE,
				//	text: parsedSummary.textMD
				}
			});
	} else if (scanRecheckTime === RECHECK_ACTION.FINISHED) {

		console.log('===  record body start on finish ===');
		console.log(recordBody);
		console.log('===  record body finish on finish ===');

		await processScanFinished(eventAttrs,recordBody,buildInfo);

	} else if (scanRecheckTime === RECHECK_ACTION.ERROR) {
		console.log(`Error canculating recheck time - check the scan status message`);
		const checkRunFailed = await checkRun.updateCheckRun(
			recordBody.repository_owner_login,
			recordBody.repository_name,
			recordBody.check_run_id,
			{	
				status: 'completed',
				conclusion: checkRun.CONCLUSION.FAILURE,
				output: {
					summary: `Unknow scan status: ${buildInfo.analysis_unit['$'].status}`,
					title: checkRun.CHECK_RESULT_TITLE
				}
			});
		console.log(checkRunFailed);
	} else if (scanRecheckTime > 0) {
		// Update if status changed
		const currentStatus = buildInfo.analysis_unit['$'].status;
		if (currentStatus !== recordBody.previous_scan_status) {
			// Sending update to the Static check
			console.log(`Status changed from ${recordBody.previous_scan_status} to ${currentStatus} - sending update`)

			const reportingStatus = getGithubStatusFromBuildStatus(buildInfo);
			const sandboxName = jsonUtil.getNested(eventAttrs,'sandboxName','stringValue');
			await checkRun.updateCheckRun(
				recordBody.repository_owner_login,
				recordBody.repository_name,
				recordBody.check_run_id,
				{	
					status: reportingStatus.status,
					conclusion: reportingStatus.conclusion,
					output: {
						title: checkRun.CHECK_RESULT_TITLE,
						summary: getStatusChangeSummary(eventAttrs.appName.stringValue,sandboxName, eventAttrs.buildID.stringValue),//`Build ${eventAttrs.buildID.stringValue} submitted. Awaiting scan results.`,
						text: `Veracode scan status update: ${currentStatus}`
					}
				});

			console.log('Github check run updated');
		}
		// any other rescan action
		console.log(`requeuing message for another check in ${scanRecheckTime} seconds`);
		// requeue same message with an update on the current status as the latest status
		await requeueMessage(eventAttrs,scanRecheckTime,JSON.stringify({...recordBody,previous_scan_status:currentStatus}),SCAN_CHECK_QUEUE_URL);
	}
	console.log('ongoingIterationHandling - END');
}

const firstIterationHandling = async (recordBody,eventAttrs) => {
	const sandboxName = jsonUtil.getNested(eventAttrs,'sandboxName','stringValue');

	const response = await getLagacyIDsFromName(eventAttrs.appName.stringValue,sandboxName);
	console.log(response);

	if (response.appLegacyID && response.appLegacyID.stringValue!=='0') {
		eventAttrs.appLegacyID = response.appLegacyID;
		eventAttrs.appGUID = response.appGUID;
		eventAttrs.orgID = response.orgID;
	} else {
		console.log('Error - could not find application id');
		return;
	}
	if (response.sandboxLegacyID) {
		eventAttrs.sandboxLegacyID = response.sandboxLegacyID;
		eventAttrs.sandboxGUID = response.sandboxGUID;
	}

	// report and create a new check-run
	let sqsBaseMessage;
	const githubRequestEventType = recordBody.github_event;
	switch (githubRequestEventType) {
		case 'push':
			sqsBaseMessage = checkRun.baseSQSMessageFromGithubEvent(recordBody);
			break;
		case 'pull_request':
			sqsBaseMessage = checkRun.baseSQSMessageFromGithubEvent(recordBody);
			sqsBaseMessage.commit_sha = recordBody.pull_request.head.sha;
			break;
	}
	
	if (sqsBaseMessage && sqsBaseMessage !== null) {
		const newCheckRun = await checkRun.createCheckRun(
			sqsBaseMessage.repository_owner_login,
			sqsBaseMessage.repository_name,
			sqsBaseMessage.commit_sha
		);
		console.log('New check run requested');

		if (newCheckRun) {
			// Adding the check run id to the sqs attributes
			eventAttrs.checkRunID = {
				dataType: "Number",
				stringValue: newCheckRun.data.id + ''
			}
			// requeue with lagacy ID
			console.log(eventAttrs);

			// re-queue with the lagacy ids;
			await requeueMessage(eventAttrs,RECHECK_ACTION.SCANNING,JSON.stringify({...sqsBaseMessage,check_run_id:newCheckRun.data.id}),SCAN_CHECK_QUEUE_URL);
			
			console.log('Finish updating with lagacy ids and requeue for scan check');
		} else {
			console.error('Could not create check-run within GitHub - Abort further processing');
			console.log(sqsBaseMessage);
		}
	} else {
		console.log(`Un supported github event type: ${recordBody.github_event}`);
	}
}

const processScanFinished = async (eventAttrs,recordBody,buildInfo) => {
	const appID = eventAttrs.appLegacyID.stringValue;
	const orgID = eventAttrs.orgID.stringValue;
	const appGUID = eventAttrs.appGUID.stringValue;
	const sandboxGUID = jsonUtil.getNested(eventAttrs,'sandboxGUID','stringValue');
	// review compliance status
	const complianceStatus = buildInfo['$'].policy_compliance_status;
	// only update if needed
	if (!recordBody.pre_calculated_updated || complianceStatus!==buildSummaryHandler.POLICY_COMPLIANCE.CALCULATING) {
		const parsedSummary = await buildSummaryHandler.getParseBuildSummary(orgID,appID,appGUID,sandboxGUID,eventAttrs.buildID.stringValue,buildInfo);

		const conclusion = calculateConclusion(parsedSummary.summaryCompliance); 
		console.log(`Current scan conclusion: '${conclusion}'`);
		const checkRunFinished = await checkRun.updateCheckRun(
			recordBody.repository_owner_login,
			recordBody.repository_name,
			recordBody.check_run_id,
			{	
				status: 'completed',
				conclusion,
				output: {
					summary: parsedSummary.summaryMD,
					title: checkRun.CHECK_RESULT_TITLE,
					text: parsedSummary.textMD
				}
			});
		console.log('Check run => updated with a complete status');
		console.log(checkRunFinished);
	}
	// if policy is not calculated, requeue again
	if (complianceStatus===buildSummaryHandler.POLICY_COMPLIANCE.CALCULATING) {
		await requeueMessage(
			eventAttrs,
			RECHECK_ACTION.AWAITING_POLICY_CALCULATION,
			JSON.stringify({...recordBody,previous_scan_status:buildInfoHandler.STATUS.RESULT_READY,pre_calculated_updated: true}),
			SCAN_CHECK_QUEUE_URL);
		console.log('Scan check finish - Re-queue for recheck as policy is being calculated');
	} else {
		// Add import issues action
		await checkRun.updateCheckRun(
			recordBody.repository_owner_login,
			recordBody.repository_name,
			recordBody.check_run_id,
			{
				actions: [
					{
						label: 'Import Findings',
						description: 'Import findings as repositories issues',
						identifier: 'import_findings'
					}
				]
			}
		);
	}
}

const calculateConclusion = (complianceStatus) => {
	console.log(`scancheckEventHandler -> calculateConclusion for : '${complianceStatus}'`)
	if (complianceStatus===buildSummaryHandler.POLICY_COMPLIANCE.PASS) {
		return checkRun.CONCLUSION.SUCCESS;
	} else if (complianceStatus===buildSummaryHandler.POLICY_COMPLIANCE.CALCULATING ||
			   complianceStatus===buildSummaryHandler.POLICY_COMPLIANCE.NOT_ASSESSED) {
		return checkRun.CONCLUSION.NATURAL;
	} else {
		return checkRun.CONCLUSION.FAILURE;
	}
}

const getStatusChangeSummary = (appName,sandboxName,buildID) => {
    let summaryHeading = `> Veracode Application: __${appName}__  `;
    if (sandboxName && sandboxName.length>0) {
      summaryHeading = `${summaryHeading}\n> Sandbox name: __${sandboxName}__  `;
	}
	summaryHeading = `${summaryHeading}\n> Build ${buildID} submitted. Awaiting scan results...`;
    return summaryHeading;
}

const getLagacyIDsFromName = async (appName,sandboxName) => {
	const retVal = {
		appLegacyID : {
			dataType: "Number",
			stringValue: '0'
		}
	}

	let response = await appsHandler.getApplicationByName(appName);
	if (response.id) {
		console.log(`adding app legacy id: ${response.id}`);
		retVal.appLegacyID = {
			dataType: "Number",
			stringValue: response.id + ''
		};
		retVal.appGUID = {
			dataType: "String",
			stringValue: response.guid
		};
		retVal.orgID = {
			dataType: "Number",
			stringValue: response.oid + ''
		};
	} else {
		// No point to continue if app id is not found
		console.log('no id parameter in the response for get application by id');
		return retVal;
	}

	console.log(`Sandbox name to look for: ${sandboxName}`);
	// Identify sandbox details
	if (sandboxName && sandboxName!==null && sandboxName.length>0) {
		let sandboxInfo = await sandboxHandler.getSandboxByName(response.guid,sandboxName);
		if (sandboxInfo.id) {
			retVal.sandboxLegacyID = {
				dataType: "Number",
				stringValue: sandboxInfo.id + ''
			};
			retVal.sandboxGUID = {
				dataType: "String",
				stringValue: sandboxInfo.guid
			};
		}
	}

	return retVal
}

const getLatestBuildStatus = async (eventAttrs) => {
	// get the build status from the API
	const appId = eventAttrs.appLegacyID.stringValue;
	let sandboxId = null;
	if (eventAttrs.sandboxLegacyID) {
		sandboxId = eventAttrs.sandboxLegacyID.stringValue;
	}
	return buildInfoHandler.getAppbuildInfo(appId,sandboxId);
}

const requeueMessage = async (msgAttrs,delay,msgBody,queueUrl) => {
	console.log('requeueMessage - START');
	// send a message to the queue
	//console.log(msgBody);

	var sqsPayload = {
		// Remove DelaySeconds parameter and value for FIFO queues
	    DelaySeconds: delay || RECHECK_ACTION.SCANNING,
	    MessageAttributes: replaceSQSMessageAttr(msgAttrs),
	   	MessageBody: msgBody || "Track Scan Status",
	   	QueueUrl: queueUrl || SCAN_CHECK_QUEUE_URL
	};

	await sqs.sendMessage(sqsPayload).promise();
	console.log('requeueMessage - END');
}

const replaceSQSMessageAttr = (msgAttr) => {
	const newMsgAttr = {};
	for (let attr of Object.keys(msgAttr)) {
		const modAttr = {};
		modAttr.DataType = msgAttr[attr].dataType;
		modAttr.StringValue = msgAttr[attr].stringValue;
		newMsgAttr[attr] = modAttr;
	}
	return newMsgAttr;
}

const calculateRescanTimeFromAnalysisUnit = (analysisUnit) => {
	let scanRecheckTime = RECHECK_ACTION.STOP;
	if (analysisUnit['$']) {
		const scanStatus = analysisUnit['$'].status;
		console.log(`calculateRescanTimeFromAnalysisUnit - Last scan status: '${scanStatus}'`);
		switch (scanStatus) {
			case buildInfoHandler.STATUS.RESULT_READY:
				scanRecheckTime = RECHECK_ACTION.FINISHED;
				break;
			case buildInfoHandler.STATUS.INCOMPLETE:
				scanRecheckTime = RECHECK_ACTION.LONGER_WAIT;
				break;
			case buildInfoHandler.STATUS.SUBMITTED_TO_SCAN:
				scanRecheckTime = RECHECK_ACTION.SHORTER_WAIT;
				break;
			case buildInfoHandler.STATUS.PRESCAN_SUBMITTED:
			case buildInfoHandler.STATUS.PRESCAN_FINISHED:
				scanRecheckTime = RECHECK_ACTION.LONGER_WAIT;
				break;
			case buildInfoHandler.STATUS.SCAN_IN_PROGRESS:
				scanRecheckTime = RECHECK_ACTION.SCANNING;
				break;
			default:
				scanRecheckTime = RECHECK_ACTION.ERROR;
				console.log(`unknown scan status: [${scanStatus}]`);
		}
	} else {
		console.log(`no '$' element in analysisUnit`);
	}
	return scanRecheckTime;
}

const getGithubStatusFromBuildStatus = (buildInfo) => {
	const status = {
		status: 'completed'
	}
	if (jsonUtil.getNested(buildInfo,'analysis_unit','$')) {
		const buildStatus = buildInfo.analysis_unit['$'].status;
		switch (buildStatus) {
			case buildInfoHandler.STATUS.RESULT_READY:
				status.conclusion = 'neutral';
				break;
			case buildInfoHandler.STATUS.INCOMPLETE:
			case buildInfoHandler.STATUS.PRESCAN_SUBMITTED:
			case buildInfoHandler.STATUS.SUBMITTED_TO_SCAN:
			case buildInfoHandler.STATUS.PRESCAN_FINISHED:
				status.status = 'queued';
				break;
			case buildInfoHandler.STATUS.SCAN_IN_PROGRESS:
				status.status = 'in_progress';
				break;
		}
	}

	return status;
}

module.exports = {
    handleEvent
}