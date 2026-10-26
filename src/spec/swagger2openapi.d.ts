declare module 'swagger2openapi' {
  interface ConvertOptions {
    patch?: boolean;
    warnOnly?: boolean;
  }
  interface ConvertResult {
    openapi: Record<string, unknown>;
  }
  const converter: {
    convertObj(spec: unknown, options: ConvertOptions): Promise<ConvertResult>;
  };
  export default converter;
}
