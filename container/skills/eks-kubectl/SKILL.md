---
name: eks-kubectl
description: EKS cluster operations — list namespaces/pods, get container logs, restart deployments and statefulsets
---

# EKS kubectl Operations

You have MCP tools for interacting with EKS clusters. **Always use these tools** rather than running kubectl or calling the Kubernetes API yourself.

## Tools

### `mcp__eks-kubectl__list_namespaces`

List all namespaces in a cluster.

- `cluster` (required) — EKS cluster name

Returns `{ cluster, namespaces: [{ name }] }`.

### `mcp__eks-kubectl__list_pods`

List running pods in a namespace.

- `cluster` (required) — EKS cluster name
- `namespace` (required) — Kubernetes namespace

Returns `{ cluster, namespace, pods: [{ name, status, restartCount }] }`.

### `mcp__eks-kubectl__get_pod_containers`

Return containers for a specific pod.

- `cluster` (required) — EKS cluster name
- `namespace` (required) — Kubernetes namespace
- `pod` (required) — Pod name

Returns `{ cluster, namespace, pod, containers: [{ name, image, status, ready, isInit }] }`.

### `mcp__eks-kubectl__get_container_logs`

Fetch logs for a specific container in a pod.

- `cluster` (required) — EKS cluster name
- `namespace` (required) — Kubernetes namespace
- `pod` (required) — Pod name
- `container` (required) — Container name
- `tail_lines` (optional) — Number of lines to tail (default 100, max 5000)

Returns `{ cluster, namespace, pod, container, tailLines, logs }`.

### `mcp__eks-kubectl__restart_deployment`

Trigger a rollout restart of a named Deployment.

- `cluster` (required) — EKS cluster name
- `namespace` (required) — Kubernetes namespace
- `deployment` (required) — Deployment name

Returns `{ cluster, result: { name, namespace, restartedAt } }`.

### `mcp__eks-kubectl__restart_statefulset`

Trigger a rollout restart of a named StatefulSet.

- `cluster` (required) — EKS cluster name
- `namespace` (required) — Kubernetes namespace
- `statefulset` (required) — StatefulSet name

Returns `{ cluster, result: { name, namespace, restartedAt } }`.

## How to Respond

1. **Call the tool first.** Do not try to reach the Kubernetes API yourself.
2. **Relay the tool's response.** Summarise for the user but do not omit important details.
3. **For logs**, present them in a code block. If truncated, mention the `tail_lines` value used.
4. **For restarts**, confirm the deployment/statefulset name, namespace, and timestamp.
5. **For errors**, relay the error message. Common errors: cluster not permitted, namespace not permitted, pod not found.
6. **When investigating issues**, a typical workflow is: `list_pods` → identify the unhealthy pod → `get_pod_containers` → `get_container_logs` on the relevant container.
