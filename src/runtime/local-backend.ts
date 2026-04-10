import type { PipelineEngine } from "../pipeline/pipeline-engine.js";
import { InProcessExecutionBackend } from "./in-process-backend.js";

export class LocalExecutionBackend extends InProcessExecutionBackend<"local"> {
  constructor(pipelineEngine: PipelineEngine) {
    super("local", pipelineEngine);
  }
}
