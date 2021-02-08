/*
* installer.ts
*
* Copyright (C) 2020 by RStudio, PBC
*
*/


// TODO: Considering making signing optional based upon the presence of env vars with cert/pw
// TODO: Could also consider moving the keychain work out of the github actions and into typescript
// TODO: Considering making notarization optional based upon the presence of credentials
// TODO: Confirm whether we should truly be signing the other, non deno, files
// TODO: Configuration could be initialized with working dir and scripts dir so sub tasks can just use that directory (and have it cleaned up automatically)
// TODO: Bundle and package Identifier - same or different?


import { dirname, join } from "path/mod.ts";
import { existsSync, ensureDirSync } from "fs/mod.ts";

import { Configuration } from "../common/config.ts";
import { Logger } from "../util/logger.ts";
import { runCmd } from "../util/cmd.ts";
import { getEnv } from "../util/utils.ts";

// Packaging specific configuration
// (Some things are global others may be platform specific)
export interface PackageInfo {
  name: string;
  identifier: string;
  packageArgs: () => string[];
}

export async function makeInstallerMac(config: Configuration) {

  const packageName = `quarto-${config.version}-macos.pkg`;
  const unsignedPackageName = `quarto-${config.version}-unsigned-macos.pkg`;
  const packageIdentifier = "org.rstudio.quarto";
  const bundleIdentifier = "org.rstudio.quarto.cli";


  // Target package
  const unsignedPackagePath = join(
    config.directoryInfo.out,
    unsignedPackageName,
  );

  config.log.info(`Packaging into ${unsignedPackagePath}`);

  // Clean any existing package
  if (existsSync(unsignedPackagePath)) {
    Deno.removeSync(unsignedPackagePath);
  }

  // Make the output dir
  ensureDirSync(dirname(unsignedPackagePath));

  // The application cert developer Id
  const applicationDevId = getEnv("QUARTO_APPLE_APP_DEV_ID");

  // Sign the deno executable
  const entitlements = join(config.directoryInfo.pkg, "scripts", "macos", "entitlements.plist");
  const deno = join(config.directoryInfo.bin, "deno");
  await signCode(applicationDevId, deno, config.log, entitlements);

  // Sign the quarto js file
  const quartojs = join(config.directoryInfo.bin, "quarto.js");
  await signCode(applicationDevId, quartojs, config.log);

  // Sign the quarto shell script
  const quartosh = join(config.directoryInfo.bin, "quarto");
  await signCode(applicationDevId, quartosh, config.log);

  // Run pkg build
  const scriptDir = join(config.directoryInfo.pkg, "scripts", "macos", "pkg");
  const packageArgs = [
    "--scripts",
    scriptDir,
    "--install-location",
    '/Library/Quarto',
  ];
  await runCmd(
    "pkgbuild",
    [
      "--root", config.directoryInfo.dist,
      "--identifier", packageIdentifier,
      "--version", config.version,
      ...packageArgs,
      "--ownership", "recommended",
      unsignedPackagePath
    ],
    config.log);

  // The application cert developer Id
  const installerDevId = getEnv("QUARTO_APPLE_INST_DEV_ID");

  config.log.info("Signing file");
  config.log.info(unsignedPackagePath);
  const signedPackage = join(config.directoryInfo.out, packageName);
  await signPackage(installerDevId, unsignedPackagePath, signedPackage, config.log);

  config.log.info("Cleaning unsigned file");
  Deno.removeSync(unsignedPackagePath);

  // Submit package for notary
  const username = getEnv("QUARTO_APPLE_CONNECT_UN");
  const password = getEnv("QUARTO_APPLE_CONNECT_PW");
  const requestId = await submitNotary(signedPackage, bundleIdentifier, username, password, config.log);

  // This will succeed or throw
  await waitForNotaryStatus(requestId, username, password, config.log);

  // Staple the notary to the package
  await stapleNotary(signedPackage, config.log);
}

async function signPackage(developerId: string, input: string, output: string, log: Logger) {
  await runCmd(
    "productsign",
    ["--sign",
      developerId,
      "--timestamp",
      input,
      output],
    log
  );
}

async function signCode(developerId: string, input: string, log: Logger, entitlements?: string) {
  const args = ["-s", developerId,
    "--timestamp",
    "--options=runtime",
    "--force",
    "--deep"];
  if (entitlements) {
    args.push("--entitlements");
    args.push(entitlements);
  }

  await runCmd(
    "codesign",
    [...args,
      input],
    log
  );
}

async function submitNotary(input: string, bundleId: string, username: string, password: string, log: Logger) {
  const result = await runCmd(
    "xcrun",
    ["altool",
      "--notarize-app",
      "--primary-bundle-id", bundleId,
      "--username", username,
      "--password", password,
      "--file", input
    ],
    log
  )
  const match = result.stdout.match(/RequestUUID = (.*)/);
  if (match) {
    const requestId = match[1];
    return requestId;
  } else {
    throw new Error("Unable to start notarization " + result.stdout);
  }
}

async function waitForNotaryStatus(requestId: string, username: string, password: string, log: Logger) {
  let notaryResult = undefined;
  while (notaryResult == undefined) {
    const result = await runCmd(
      "xcrun",
      ["altool",
        "--notarization-info", requestId,
        "--username", username,
        "--password", password,
      ],
      log
    );

    const match = result.stdout.match(/Status: (.*)\n/);
    if (match) {
      const status = match[1];
      if (status === "in progress") {
        // Sleep for 15 seconds between checks
        await new Promise((resolve) => setTimeout(resolve, 15 * 1000));
      } else if (status === "success") {
        notaryResult = "Success";
      } else {
        log.error(result.stderr);
        throw new Error("Failed to Notarize - " + status);
      }
    }
  }
  return notaryResult;
}

async function stapleNotary(input: string, log: Logger) {
  await runCmd(
    "xcrun",
    ["stapler",
      "staple", input],
    log
  );
}