export interface RPCRequest {
  method: string;
  params: unknown[];
  headers?: Record<string, string>;
  /** Optional raw request body, for interceptors (e.g. compression) that operate below the RPC param layer. */
  body?: unknown;
}

export interface RPCResponse {
  method: string;
  result: unknown;
  durationMs: number;
  /** Optional response headers, for interceptors (e.g. compression) that need transport-level metadata. */
  headers?: Record<string, string>;
  /** Optional raw response body, for interceptors (e.g. compression) that operate below the RPC result layer. */
  body?: unknown;
}

export type RequestInterceptor = (req: RPCRequest) => RPCRequest | Promise<RPCRequest>;
export type ResponseInterceptor = (res: RPCResponse) => RPCResponse | Promise<RPCResponse>;

const requestInterceptors: RequestInterceptor[] = [];
const responseInterceptors: ResponseInterceptor[] = [];

export function addRequestInterceptor(fn: RequestInterceptor): void {
  requestInterceptors.push(fn);
}

export function addResponseInterceptor(fn: ResponseInterceptor): void {
  responseInterceptors.push(fn);
}

export async function runRequestInterceptors(req: RPCRequest): Promise<RPCRequest> {
  return requestInterceptors.reduce(
    async (acc, fn) => fn(await acc),
    Promise.resolve(req)
  );
}

export async function runResponseInterceptors(res: RPCResponse): Promise<RPCResponse> {
  return responseInterceptors.reduce(
    async (acc, fn) => fn(await acc),
    Promise.resolve(res)
  );
}
