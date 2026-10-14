import { OpenLITUsageClient } from "./openlit-usage-client.ts";

const DEFAULT_BASE_URL = "http://127.0.0.1:3000";
const serviceToken = process.env.AUTODEV_OPENLIT_USAGE_TOKEN?.trim();

if (serviceToken) {
  const client = new OpenLITUsageClient({
    baseUrl: process.env.AUTODEV_OPENLIT_USAGE_URL?.trim() || DEFAULT_BASE_URL,
    serviceToken
  });
  const result = await client.query({ range: "24H", values: {} });

  switch (result.kind) {
    case "ok": {
      process.stdout.write("[openlit] Usage v4 response contract verified.\n");
      break;
    }
    case "invalid-response": {
      process.stderr.write(
        "[openlit] Usage API returned a response that does not match the required v4 contract. Rebuild/reconcile the patched OpenLIT image.\n"
      );
      process.exitCode = 1;
      break;
    }
    case "unauthorized": {
      process.stderr.write(
        `[openlit] Usage API rejected its server credential with HTTP ${result.status}.\n`
      );
      process.exitCode = 1;
      break;
    }
    case "http-error": {
      process.stderr.write(
        `[openlit] Usage API returned HTTP ${result.status} during contract verification.\n`
      );
      process.exitCode = 1;
      break;
    }
    case "unreachable": {
      process.stderr.write(
        "[openlit] Usage API could not be reached during contract verification.\n"
      );
      process.exitCode = 1;
      break;
    }
  }
} else {
  process.stderr.write(
    "[openlit] AUTODEV_OPENLIT_USAGE_TOKEN is required to verify the Usage API.\n"
  );
  process.exitCode = 1;
}
