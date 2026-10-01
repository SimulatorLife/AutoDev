export interface ParameterizedQuery {
  readonly query: string;
  readonly params: Record<string, string | number | boolean>;
}

export class ClickHouseTelemetryClient {
  readonly endpoint: string;

  constructor(endpoint = "http://127.0.0.1:8123") {
    this.endpoint = endpoint;
  }

  buildTraceQuery(options: {
    serviceName: string;
    startTime: string;
    endTime: string;
    limit?: number;
    filters?: Record<string, string>;
  }): ParameterizedQuery {
    const params: Record<string, string | number | boolean> = {
      service: options.serviceName,
      start: options.startTime,
      end: options.endTime,
      limit: options.limit ?? 100
    };

    let query =
      "SELECT TraceId, SpanId, SpanName, Duration, StatusCode, ServiceName " +
      "FROM otel_traces WHERE ServiceName = {service:String} " +
      "AND Timestamp >= {start:DateTime64} AND Timestamp <= {end:DateTime64}";

    if (options.filters) {
      let filterIndex = 0;
      for (const [key, value] of Object.entries(options.filters)) {
        const paramKey = `f_${filterIndex}`;
        params[paramKey] = value;
        query += ` AND SpanAttributes['${key}'] = {${paramKey}:String}`;
        filterIndex += 1;
      }
    }

    query += " ORDER BY Timestamp DESC LIMIT {limit:UInt32}";

    return { query, params };
  }
}
