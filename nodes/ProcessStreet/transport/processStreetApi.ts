import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	IWebhookFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';

const BASE_URL = 'https://public-api.process.st/api/v1.1';

type ContextType =
	| IExecuteFunctions
	| IHookFunctions
	| ILoadOptionsFunctions
	| IWebhookFunctions;

/**
 * Make a single authenticated request to the Process Street API.
 */
export async function processStreetApiRequest(
	this: ContextType,
	method: IHttpRequestMethods,
	endpoint: string,
	body: IDataObject = {},
	qs: IDataObject = {},
): Promise<any> {
	const options: IHttpRequestOptions = {
		method,
		url: `${BASE_URL}${endpoint}`,
		json: true,
	};

	if (Object.keys(body).length > 0) {
		options.body = body;
	}
	if (Object.keys(qs).length > 0) {
		options.qs = qs;
	}

	try {
		return await this.helpers.httpRequestWithAuthentication.call(
			this,
			'processStreetApi',
			options,
		);
	} catch (error) {
		throw buildProcessStreetApiError.call(this, error, method, endpoint);
	}
}

/**
 * Build a NodeApiError that surfaces the raw Process Street response body.
 *
 * The default NodeApiError wrapping often collapses the remote body into a
 * generic message ("Your request is invalid or could not be processed by the
 * service"), which hides the field-level reason from the n8n UI. Process
 * Street typically returns a JSON body like `{ code, message, errors: [...] }`
 * on 4xx — we stringify that and attach it as the error description so the
 * user sees the actionable detail directly in the node panel.
 */
function buildProcessStreetApiError(
	this: ContextType,
	error: unknown,
	method: IHttpRequestMethods,
	endpoint: string,
): NodeApiError {
	const err = error as {
		response?: { body?: unknown; statusCode?: number };
		statusCode?: number;
		httpCode?: number;
		message?: string;
		cause?: { response?: { body?: unknown } };
	};

	const body =
		err?.response?.body ??
		err?.cause?.response?.body ??
		(err as IDataObject)?.body;
	const statusCode =
		err?.response?.statusCode ?? err?.statusCode ?? err?.httpCode;

	let remoteMessage: string | undefined;
	let description: string | undefined;

	if (body !== undefined && body !== null) {
		if (typeof body === 'string') {
			description = body;
			try {
				const parsed = JSON.parse(body);
				if (parsed && typeof parsed === 'object') {
					remoteMessage = (parsed as IDataObject).message as string;
					description = JSON.stringify(parsed, null, 2);
				}
			} catch {
				// body wasn't JSON — keep the raw string as description
			}
		} else if (typeof body === 'object') {
			remoteMessage = (body as IDataObject).message as string;
			description = JSON.stringify(body, null, 2);
		}
	}

	const message =
		remoteMessage ??
		err?.message ??
		`Process Street API request failed (${method} ${endpoint})`;

	return new NodeApiError(this.getNode(), error as unknown as JsonObject, {
		message,
		description,
		httpCode: statusCode !== undefined ? String(statusCode) : undefined,
	});
}

/**
 * Fetch all pages of results from a paginated Process Street API endpoint.
 * Process Street uses link-based pagination with 20 items per page.
 * The response includes a `links` array; a link with rel "next" points to the next page.
 */
export async function processStreetApiRequestAllItems(
	this: ContextType,
	method: IHttpRequestMethods,
	endpoint: string,
	body: IDataObject = {},
	qs: IDataObject = {},
	dataKey?: string,
): Promise<any[]> {
	const results: any[] = [];
	let nextUrl: string | undefined = `${BASE_URL}${endpoint}`;
	let isFirstRequest = true;

	do {
		const options: IHttpRequestOptions = {
			method,
			url: nextUrl,
			json: true,
		};

		if (Object.keys(body).length > 0) {
			options.body = body;
		}
		// Only apply query string params on the first request;
		// subsequent pages encode params in the URL.
		if (isFirstRequest && Object.keys(qs).length > 0) {
			options.qs = qs;
		}

		const response = await this.helpers.httpRequestWithAuthentication.call(
			this,
			'processStreetApi',
			options,
		);

		const items = dataKey ? response[dataKey] : response;
		if (Array.isArray(items)) {
			results.push(...items);
		} else if (items && typeof items === 'object') {
			// If the response is an object with a known collection key, try common keys
			for (const key of [
				'workflows',
				'workflowRuns',
				'tasks',
				'users',
				'assignees',
				'fields',
				'approvals',
			]) {
				if (Array.isArray(items[key])) {
					results.push(...items[key]);
					break;
				}
			}
		}

		// Extract next page URL from links.
		// The Process Street API marks the next-page link with name="next".
		// The rel field is a resource-type label (e.g. "Tasks") — not "next".
		nextUrl = undefined;
		if (response?.links) {
			if (Array.isArray(response.links)) {
				const nextLink = response.links.find(
					(l: any) => l.name === 'next',
				);
				if (nextLink?.href) {
					nextUrl = nextLink.href;
				}
			} else if (response.links.next?.href) {
				nextUrl = response.links.next.href;
			}
		}

		isFirstRequest = false;
	} while (nextUrl);

	return results;
}
