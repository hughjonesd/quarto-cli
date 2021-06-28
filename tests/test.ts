import { existsSync } from "fs/mod.ts";
import { warning } from "log/mod.ts";

import { cleanupLogger, initializeLogger } from "../src/core/log.ts";
import { quarto } from "../src/quarto.ts";

/*
* test.ts
*
* Copyright (C) 2020 by RStudio, PBC
*
*/
export interface TestDescriptor {
  // The name of the test
  name: string;

  // Sets up the test
  context: TestContext;

  // Executes the test
  execute: () => Promise<void>;

  // Used to verify the outcome of the test
  verify: Verify[];

  // type of test
  type: "smoke" | "unit";
}

export interface TestContext {
  name?: string;

  // Checks that prereqs for the test are met
  prereq?: () => Promise<boolean>;

  // Cleans up the test
  teardown?: () => Promise<void>;

  // Sets up the test
  setup?: () => Promise<void>;
}

export function testQuartoCmd(
  cmd: string,
  args: string[],
  verify: Verify[],
  context?: TestContext,
) {
  const name = `quarto ${cmd} ${args.join(" ")}`;
  test({
    name,
    execute: async () => {
      await quarto([cmd, ...args]);
    },
    verify,
    context: context || {},
    type: "smoke",
  });
}

export interface Verify {
  name: string;
  verify: (outputs: ExecuteOutput[]) => Promise<void>;
}

export interface ExecuteOutput {
  msg: string;
  level: number;
  levelName: string;
}

export function unitTest(
  name: string,
  ver: VoidFunction,
) {
  test({
    name,
    type: "unit",
    context: {},
    execute: () => {
      return Promise.resolve();
    },
    verify: [
      {
        name: `${name}`,
        verify: (_outputs: ExecuteOutput[]) => {
          ver();
          return Promise.resolve();
        },
      },
    ],
  });
}

export function test(test: TestDescriptor) {
  const testName = test.context.name
    ? `[${test.type}] > ${test.name} (${test.context.name})`
    : `[${test.type}] > ${test.name}`;

  Deno.test(testName, async () => {
    const runTest = !test.context.prereq || await test.context.prereq();
    if (runTest) {
      if (test.context.setup) {
        await test.context.setup();
      }

      // Capture the output
      const log = "test-out.json";
      await initializeLogger({
        log: log,
        level: "DEBUG",
        format: "json-stream",
        quiet: true,
      });

      try {
        await test.execute();

        // Cleanup the output logging
        await cleanupLogger();

        // Read the output
        if (existsSync(log)) {
          const testOutput = readExecuteOutput(log);
          Deno.removeSync(log);

          for (const ver of test.verify) {
            await ver.verify(testOutput);
          }
        }
      } finally {
        if (test.context.teardown) {
          await test.context.teardown();
        }
      }
    } else {
      warning(`Skipped - ${test.name}`);
    }
  });
}

function readExecuteOutput(log: string) {
  const jsonStream = Deno.readTextFileSync(log);
  const lines = jsonStream.split("\n").filter((line) => !!line);
  return lines.map((line) => {
    return JSON.parse(line) as ExecuteOutput;
  });
}
