import type { INodeProperties } from 'n8n-workflow';

export const workflowRunOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: {
			show: {
				resource: ['workflowRun'],
			},
		},
		options: [
			{
				name: 'Create',
				value: 'create',
				description: 'Create a new workflow run',
				action: 'Create a workflow run',
			},
			{
				name: 'Delete',
				value: 'delete',
				description: 'Delete a workflow run',
				action: 'Delete a workflow run',
			},
			{
				name: 'Find',
				value: 'find',
				description: 'Search for workflow runs',
				action: 'Find workflow runs',
			},
			{
				name: 'Get',
				value: 'get',
				description: 'Get a workflow run by ID',
				action: 'Get a workflow run',
			},
			{
				name: 'Update',
				value: 'update',
				description: 'Update a workflow run',
				action: 'Update a workflow run',
			},
		],
		default: 'create',
	},
];

export const workflowRunFields: INodeProperties[] = [
	// ──────────────────────────────────────────
	//              CREATE
	// ──────────────────────────────────────────
	{
		displayName: 'Workflow Name or ID',
		name: 'workflowId',
		type: 'options',
		typeOptions: {
			loadOptionsMethod: 'getWorkflows',
		},
		required: true,
		displayOptions: {
			show: {
				resource: ['workflowRun'],
				operation: ['create'],
			},
		},
		default: '',
		description:
			'The workflow to run. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},
	{
		displayName: 'Run Name',
		name: 'name',
		type: 'string',
		required: true,
		displayOptions: {
			show: {
				resource: ['workflowRun'],
				operation: ['create'],
			},
		},
		default: '',
		description: 'Name for the new workflow run',
	},
	{
		displayName: 'Search Before Creating',
		name: 'searchBeforeCreate',
		type: 'boolean',
		displayOptions: {
			show: {
				resource: ['workflowRun'],
				operation: ['create'],
			},
		},
		default: false,
		description:
			'Whether to search for an existing workflow run with the same name before creating a new one. If found, returns the existing run instead.',
	},
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		displayOptions: {
			show: {
				resource: ['workflowRun'],
				operation: ['create'],
			},
		},
		default: {},
		options: [
			{
				displayName: 'Due Date',
				name: 'dueDate',
				type: 'dateTime',
				default: '',
				description: 'Due date for the workflow run',
			},
			{
				displayName: 'Shared',
				name: 'shared',
				type: 'boolean',
				default: false,
				description: 'Whether the workflow run is shared',
			},
		],
	},

	// ──────────────────────────────────────────
	//          CREATE - Form Fields (Resource Mapper)
	// ──────────────────────────────────────────
	{
		displayName: 'Form Fields',
		name: 'formFields',
		type: 'resourceMapper',
		noDataExpression: true,
		default: {
			mappingMode: 'defineBelow',
			value: null,
		},
		typeOptions: {
			loadOptionsDependsOn: ['workflowId'],
			resourceMapper: {
				resourceMapperMethod: 'getFormFields',
				mode: 'add',
				fieldWords: {
					singular: 'Field',
					plural: 'Fields',
				},
				addAllFields: true,
				multiKeyMatch: false,
				supportAutoMap: false,
			},
		},
		displayOptions: {
			show: {
				resource: ['workflowRun'],
				operation: ['create'],
			},
		},
		description:
			'Set form field values for the workflow run. Select a Workflow first — the form will load automatically with all available fields.',
	},

	// ──────────────────────────────────────────
	//    CREATE - Multi-Select Fields (checkboxes)
	// ──────────────────────────────────────────
	{
		displayName: 'Multi-Select Fields',
		name: 'multiSelectFields',
		type: 'fixedCollection',
		typeOptions: {
			multipleValues: true,
		},
		placeholder: 'Add Multi-Select Field',
		displayOptions: {
			show: {
				resource: ['workflowRun'],
				operation: ['create'],
			},
		},
		default: {},
		description: 'Set checklist/multi-select form field values. Click "Add Multi-Select Field" to add an entry.',
		options: [
			{
				name: 'fields',
				displayName: 'Field',
				values: [
					{
						displayName: 'Field Name or ID',
						name: 'fieldId',
						type: 'options',
						typeOptions: {
							loadOptionsMethod: 'getMultiSelectFormFields',
							loadOptionsDependsOn: ['workflowId'],
						},
						default: '',
						description: 'The multi-select form field to set. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
					},
					{
						displayName: 'Values',
						name: 'values',
						type: 'multiOptions',
						typeOptions: {
							loadOptionsMethod: 'getMultiSelectFieldOptions',
							loadOptionsDependsOn: ['workflowId'],
						},
						default: [],
						description: 'Check off items for the selected field. Items are labeled with [field name] to identify which field they belong to.',
					},
				],
			},
		],
	},

	// ──────────────────────────────────────────
	//          GET / UPDATE / DELETE
	// ──────────────────────────────────────────
	{
		displayName: 'Workflow Run ID',
		name: 'workflowRunId',
		type: 'string',
		required: true,
		displayOptions: {
			show: {
				resource: ['workflowRun'],
				operation: ['get', 'update', 'delete'],
			},
		},
		default: '',
		description: 'The ID of the workflow run',
	},

	// ──────────────────────────────────────────
	//              UPDATE
	// ──────────────────────────────────────────
	{
		displayName: 'Update Fields',
		name: 'updateFields',
		type: 'collection',
		placeholder: 'Add Field',
		displayOptions: {
			show: {
				resource: ['workflowRun'],
				operation: ['update'],
			},
		},
		default: {},
		description:
			'Fields to update. Note: the Process Street API requires all fields to be sent on update, so unchanged fields will be fetched from the current run.',
		options: [
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				default: '',
				description: 'New name for the workflow run',
			},
			{
				displayName: 'Status',
				name: 'status',
				type: 'options',
				options: [
					{ name: 'Active', value: 'Active' },
					{ name: 'Archived', value: 'Archived' },
					{ name: 'Completed', value: 'Completed' },
				],
				default: 'Active',
				description: 'New status for the workflow run',
			},
			{
				displayName: 'Due Date',
				name: 'dueDate',
				type: 'dateTime',
				default: '',
				description: 'New due date for the workflow run',
			},
			{
				displayName: 'Shared',
				name: 'shared',
				type: 'boolean',
				default: false,
				description: 'Whether the workflow run is shared',
			},
		],
	},

	// ──────────────────────────────────────────
	//              FIND
	// ──────────────────────────────────────────
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		displayOptions: {
			show: {
				resource: ['workflowRun'],
				operation: ['find'],
			},
		},
		default: false,
		description: 'Whether to return all results or only up to a given limit',
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		displayOptions: {
			show: {
				resource: ['workflowRun'],
				operation: ['find'],
				returnAll: [false],
			},
		},
		typeOptions: { minValue: 1, maxValue: 100 },
		default: 20,
		description: 'Max number of results to return',
	},
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		displayOptions: {
			show: {
				resource: ['workflowRun'],
				operation: ['find'],
			},
		},
		default: {},
		options: [
			{
				displayName: 'Workflow Name or ID',
				name: 'workflowId',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getWorkflows',
				},
				default: '',
				description:
					'Filter by workflow. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				default: '',
				description: 'Filter by name (partial match, case-insensitive)',
			},
			{
				displayName: 'Status',
				name: 'status',
				type: 'options',
				options: [
					{ name: 'Active', value: 'Active' },
					{ name: 'Archived', value: 'Archived' },
					{ name: 'Completed', value: 'Completed' },
				],
				default: 'Active',
				description: 'Filter by status',
			},
		],
	},
];
