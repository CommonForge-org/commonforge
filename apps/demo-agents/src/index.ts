/** @commonforge-org/demo-agents — three concurrent agent sessions against CommonForge (Task 19). */
export const DEMO_AGENT_COUNT = 3;

export { agentCliEnv, claudeArgs, codexArgs, realAgent, type AgentCliName, type AgentRun, type AgentRunner } from "./agent-cli.js";
export { replaceAsset } from "./assets.js";
export { agentIdentity, cforgeBin, cforgeJson, subprocessCforge, type CforgeRunner } from "./cforge.js";
export { probeTextualConflict, type ConflictProbe } from "./conflict.js";
export { checkQuoteContract, type ContractResult } from "./contract-check.js";
export { dryRunAgent } from "./dry-run.js";
export { concurrencyEvidence, timelines, type ConcurrencyEvidence } from "./evidence.js";
export { apiGate, localGate, type ContractGate, type GateOutcome } from "./gate.js";
export { DEFAULT_MOUNTS, runDemo, type DemoConfig, type DemoReport } from "./orchestrator.js";
export { OwnerApi, loadOwnerSession, ownerConfigDir } from "./owner-api.js";
export * from "./prompts.js";
