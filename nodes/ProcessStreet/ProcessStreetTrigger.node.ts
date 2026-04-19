import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';

import { processStreetApiRequest } from './transport/processStreetApi';
import { getWorkflows, getTasks } from './methods/loadOptions';

export class ProcessStreetTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Process Street Trigger',
		name: 'processStreetTrigger',
		icon: 'file:processStreet.svg',
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["event"]}}',
		description:
			'Starts the workflow when a Process Street event occurs. ℹ️ For webhook triggers, activate the workflow to register the webhook — Process Street rejects n8n test-mode URLs.',
		defaults: {
			name: 'Process Street Trigger',
		},
		inputs: [],
		outputs: ['main'],
		credentials: [
			{
				name: 'processStreetApi',
				required: true,
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName: 'Event',
				name: 'event',
				type: 'options',
				required: true,
				options: [
					{
						name: 'Task Checked',
						value: 'TaskChecked',
						description: 'Triggers when a task is checked off',
					},
					{
						name: 'Task Ready',
						value: 'TaskReady',
						description: 'Triggers when a task is ready to be worked on',
					},
					{
						name: 'Workflow Run Completed',
						value: 'WorkflowRunCompleted',
						description: 'Triggers when a workflow run is completed',
					},
					{
						name: 'Workflow Run Created',
						value: 'WorkflowRunCreated',
						description: 'Triggers when a new workflow run is created',
					},
				],
				default: 'WorkflowRunCreated',
				description: 'The event to listen for',
			},
			{
				displayName: 'Workflow Name or ID',
				name: 'workflowId',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getWorkflows',
				},
				default: '',
				description:
					'Optionally filter to a specific workflow. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Task Name or ID',
				name: 'taskId',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getTasks',
					loadOptionsDependsOn: ['workflowId'],
				},
				displayOptions: {
					show: {
						event: ['TaskChecked', 'TaskReady'],
					},
				},
				default: '',
				description:
					'Optionally filter to a specific task. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
		],
	};

	methods = {
		loadOptions: {
			getWorkflows,
			getTasks,
		},
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const webhookData = this.getWorkflowStaticData('node');
				const webhookId = webhookData.webhookId as string | undefined;

				// If we have a stored webhook ID, assume it exists.
				// Process Street doesn't expose a GET /webhooks/{id} endpoint.
				return !!webhookId;
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const webhookUrl = this.getNodeWebhookUrl('default') as string;
				const event = this.getNodeParameter('event') as string;
				const workflowId = this.getNodeParameter(
					'workflowId',
					'',
				) as string;
				const taskId = this.getNodeParameter('taskId', '') as string;

				const body: IDataObject = {
					url: webhookUrl,
					triggers: [event],
				};

				if (workflowId) {
					body.workflowId = workflowId;
				}
				if (taskId) {
					body.taskId = taskId;
				}

				const response = await processStreetApiRequest.call(
					this,
					'POST',
					'/webhooks',
					body,
				);

				const webhookData = this.getWorkflowStaticData('node');
				webhookData.webhookId = response.id;

				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const webhookData = this.getWorkflowStaticData('node');
				const webhookId = webhookData.webhookId as string | undefined;

				if (!webhookId) return true;

				try {
					await processStreetApiRequest.call(
						this,
						'DELETE',
						`/webhooks/${webhookId}`,
					);
				} catch {
					// Webhook may have already been deleted externally
					return false;
				}

				delete webhookData.webhookId;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const body = this.getBodyData() as IDataObject;
		return {
			workflowData: [this.helpers.returnJsonArray(body)],
		};
	}
}
