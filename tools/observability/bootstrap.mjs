import {fileURLToPath} from 'node:url';
import {materializeCollectorSecrets, materializeGrafanaAdminSecret, provisionDevelopmentGrafanaAdmin} from '../config-bootstrap/index.mjs';

export {materializeCollectorSecrets, materializeGrafanaAdminSecret, provisionDevelopmentGrafanaAdmin};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes("--provision-development-grafana-admin")) {
      const result = await provisionDevelopmentGrafanaAdmin();
      console.log(`development Grafana admin: ${result.created ? "created" : "existing"}, ${result.path}`);
    } else {
    const collector = await materializeCollectorSecrets();
    const grafana = await materializeGrafanaAdminSecret();
    console.log(`scoped secrets materialized: ${collector.path}, ${grafana.path}`);
    }
  } catch (error) {
    console.error(`observability bootstrap failed: ${error.message}`);
    process.exitCode = 1;
  }
}
