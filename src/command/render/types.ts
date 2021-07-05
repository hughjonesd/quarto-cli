/*
* types.ts
*
* Copyright (C) 2020 by RStudio, PBC
*
*/

import { Document } from "deno_dom/deno-dom-wasm.ts";

import { Format } from "../../config/format.ts";
import {
  ExecuteResult,
  ExecutionEngine,
  ExecutionTarget,
} from "../../execute/types.ts";

import { RenderFlags } from "./flags.ts";
import { ProjectContext } from "../../project/project-shared.ts";
import { OutputRecipe } from "./output.ts";

// options for render
export interface RenderOptions {
  flags?: RenderFlags;
  pandocArgs?: string[];
  useFreezer?: boolean;
  devServerReload?: boolean;
}

// context for render
export interface RenderContext {
  target: ExecutionTarget;
  options: RenderOptions;
  engine: ExecutionEngine;
  format: Format;
  libDir: string;
  project?: ProjectContext;
}

export interface RunPandocResult {
  resources: string[];
  htmlPostprocessors: Array<(doc: Document) => Promise<string[]>>;
}

export interface RenderResourceFiles {
  globs: string[];
  files: string[];
}

export interface RenderResult {
  baseDir?: string;
  outputDir?: string;
  files: RenderResultFile[];
  error?: Error;
}

export interface RenderResultFile {
  input: string;
  markdown: string;
  format: Format;
  file: string;
  supporting?: string[];
  resourceFiles: string[];
}

export interface RenderedFile {
  input: string;
  markdown: string;
  format: Format;
  file: string;
  supporting?: string[];
  resourceFiles: RenderResourceFiles;
  selfContained: boolean;
}

export interface RenderExecuteOptions {
  resolveDependencies?: boolean;
  alwaysExecute?: boolean;
}

export interface ExecutedFile {
  context: RenderContext;
  recipe: OutputRecipe;
  executeResult: ExecuteResult;
  resourceFiles: string[];
}

export interface PandocRenderer {
  onBeforeExecute: (format: Format) => RenderExecuteOptions;
  onRender: (format: string, file: ExecutedFile) => Promise<void>;
  onComplete: (error?: boolean) => Promise<RenderFilesResult>;
}

export interface RenderFilesResult {
  files: RenderedFile[];
  error?: Error;
}