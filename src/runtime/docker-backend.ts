import type { PipelineEngine } from "../pipeline/pipeline-engine.js";
import { InProcessExecutionBackend } from "./in-process-backend.js";

export class DockerExecutionBackend extends InProcessExecutionBackend<"docker"> {
  constructor(pipelineEngine: PipelineEngine) {
    super("docker", pipelineEngine);
  }
}
