# ADR-0008: Docker-first, Kubernetes после process isolation

**Status:** Accepted target

Любой новый deployable workload получает Dockerfile/health/metrics до production integration. Compose — reference runtime. Kubernetes запускает те же immutable images после доказанного process/failure/resource split.
