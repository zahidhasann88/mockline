export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type UnknownRecord = Record<string, unknown>;

export interface JsonSchema extends UnknownRecord {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: unknown[];
  const?: unknown;
  $ref?: string;
}

export interface MediaTypeObject extends UnknownRecord {
  schema?: JsonSchema;
  example?: unknown;
  examples?: Record<string, ExampleObject | unknown>;
}

export interface ExampleObject extends UnknownRecord {
  value?: unknown;
  externalValue?: string;
  summary?: string;
}

export interface ApiResponse extends UnknownRecord {
  description?: string;
  content?: Record<string, MediaTypeObject>;
  headers?: Record<string, UnknownRecord>;
}

export interface ApiParameter extends UnknownRecord {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
  schema?: JsonSchema;
  style?: string;
  explode?: boolean;
}

export interface ApiOperation extends UnknownRecord {
  operationId?: string;
  parameters?: ApiParameter[];
  requestBody?: UnknownRecord;
  responses?: Record<string, ApiResponse>;
  security?: Array<Record<string, string[]>>;
  summary?: string;
}

export interface ApiPathItem extends UnknownRecord {
  parameters?: ApiParameter[];
  servers?: Array<{ url: string }>;
}

export interface ApiServer {
  url: string;
  variables?: Record<string, { default?: string; enum?: string[] }>;
}

export interface OpenApiDocument extends UnknownRecord {
  openapi?: string;
  swagger?: string;
  info?: UnknownRecord;
  servers?: ApiServer[];
  paths?: Record<string, ApiPathItem>;
  components?: {
    schemas?: Record<string, JsonSchema>;
    securitySchemes?: Record<string, UnknownRecord>;
    [key: string]: unknown;
  };
  security?: Array<Record<string, string[]>>;
}

export interface MatchedRoute {
  method: string;
  path: string;
  routePath: string;
  specPath: string;
  operationId: string;
  operation: ApiOperation;
  pathItem: ApiPathItem;
  parameters: ApiParameter[];
  score: number;
}

export type ResponseSource = 'example' | 'generated' | 'override' | 'proxy' | 'state';

export interface RecordedRequest {
  id: string;
  timestamp: string;
  method: string;
  url: string;
  operationId?: string;
  matchedPath?: string;
  headers: Record<string, string | string[]>;
  body?: unknown;
  responseStatus: number;
  responseSource: ResponseSource | 'inspector' | 'error';
  durationMs: number;
  validationErrors: string[];
}

export interface RequestFilter {
  method?: string;
  path?: string;
  status?: number;
  operationId?: string;
  since?: string | Date;
  limit?: number;
}

export interface MockResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  delay?: number;
  source: ResponseSource;
}

export interface SummaryOperation {
  method: string;
  path: string;
  operationId: string;
  defaultStatus: string;
  source: 'example' | 'override' | 'schema generation';
}
