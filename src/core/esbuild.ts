/*
* esbuild.ts
*
* Copyright (C) 2021 by RStudio, PBC
*
*/

import { execProcess } from "./process.ts";
import { binaryPath } from "./resources.ts";

export async function esbuildCompile(
  input: string,
  workingDir: string,
  args?: string[],
  format?: "esm" | "iife",
): Promise<string | undefined> {
  if (format === undefined) {
    format = "esm";
  }
  const fullArgs = [
    "--bundle",
    `--format=${format}`,
    ...(args || []),
  ];

  return await esbuildCommand(fullArgs, input, workingDir);
}

async function esbuildCommand(
  args: string[],
  input: string,
  workingDir: string,
) {
  const cmd = [
    binaryPath("esbuild"),
    ...args,
  ];

  const result = await execProcess(
    {
      cmd,
      cwd: workingDir,
      stdout: "piped",
    },
    input,
  );

  if (result.success) {
    return result.stdout;
  } else {
    throw new Error("esbuild command failed");
  }
}
