/*
* serve.ts
*
* Copyright (C) 2020 by RStudio, PBC
*
*/

import * as colors from "fmt/colors.ts";

import { existsSync } from "fs/mod.ts";
import { basename, dirname, extname, join, posix, relative } from "path/mod.ts";

import { Response, serve, ServerRequest } from "http/server.ts";

import { message } from "../../core/console.ts";
import { openUrl } from "../../core/shell.ts";
import { contentType, isHtmlContent } from "../../core/mime.ts";
import { pathWithForwardSlashes } from "../../core/path.ts";

import { kOutputDir, ProjectContext } from "../../project/project-context.ts";
import { inputFileForOutputFile } from "../../project/project-index.ts";

import {
  ProjectServe,
  projectType,
} from "../../project/types/project-types.ts";

import { renderProject } from "../render/project.ts";
import { renderResultFinalOutput } from "../render/render.ts";

import { ProjectWatcher, watchProject } from "./watch.ts";

export const kLocalhost = "127.0.0.1";

export type ServeOptions = {
  port: number;
  render?: boolean;
  browse?: boolean;
  watch?: boolean;
  navigate?: boolean;
  quiet?: boolean;
  debug?: boolean;
};

export async function serveProject(
  project: ProjectContext,
  options: ServeOptions,
) {
  // provide defaults
  options = {
    render: true,
    browse: true,
    watch: true,
    navigate: true,
    quiet: false,
    debug: false,
    ...options,
  };

  // render the project
  const renderResult = await renderProject(project, {
    useFreezer: true,
    flags: {
      quiet: options.quiet,
      debug: options.debug,
    },
  });

  // get project serve hooks and call init if we have it
  const projType = projectType(project.metadata?.project?.type);
  const projServe = projType.serve;
  if (projServe?.init) {
    projServe.init(project);
  }

  // determine site dir
  const outputDir = project.metadata?.project?.[kOutputDir];
  const siteDir = outputDir ? join(project.dir, outputDir) : project.dir;

  // create project watcher
  const watcher = watchProject(project, options, renderResult, projServe);

  // main request handler
  const handler = async (req: ServerRequest): Promise<void> => {
    // handle watcher request
    if (watcher.handle(req)) {
      return await watcher.connect(req);
    }

    // handle file requests
    let response: Response | undefined;
    let fsPath: string | undefined;
    try {
      const normalizedUrl = normalizeURL(req.url);
      fsPath = posix.join(siteDir, normalizedUrl)!;
      if (fsPath!.indexOf(siteDir) !== 0) {
        fsPath = siteDir;
      }
      const fileInfo = await Deno.stat(fsPath!);
      if (fileInfo.isDirectory) {
        fsPath = join(fsPath, "index.html");
      }
      response = await serveFile(fsPath!, watcher, projServe);
      if (options.debug) {
        printUrl(normalizedUrl);
      }
    } catch (e) {
      response = await serveFallback(req, e, fsPath!, options);
    } finally {
      try {
        await req.respond(response!);
      } catch (e) {
        console.error(e);
      }
    }
  };

  // serve project
  const server = serve({ port: options.port, hostname: kLocalhost });

  // compute site url
  const siteUrl = `http://localhost:${options.port}/`;

  // print status
  if (!options.quiet) {
    const siteDirRelative = relative(Deno.cwd(), siteDir);
    message(`\nServing site from ${siteDirRelative}`, {
      bold: true,
      format: colors.green,
    });
    if (options.watch) {
      message("Watching project for reload on changes", {
        indent: 1,
      });
    }
    message(`Browse the site at `, {
      indent: 1,
      newline: false,
    });
    message(`${siteUrl}`, { format: colors.underline });
  }

  // open browser if requested
  if (options.browse) {
    if (renderResult.baseDir && renderResult.outputDir) {
      const finalOutput = renderResultFinalOutput(renderResult);
      const targetPath = pathWithForwardSlashes(relative(
        join(renderResult.baseDir, renderResult.outputDir),
        finalOutput,
      ));
      openUrl(targetPath === "index.html" ? siteUrl : siteUrl + targetPath);
    } else {
      openUrl(siteUrl);
    }
  }

  // wait for requests
  for await (const req of server) {
    handler(req);
  }
}

function serveFallback(
  req: ServerRequest,
  e: Error,
  fsPath: string,
  options: ServeOptions,
): Promise<Response> {
  const encoder = new TextEncoder();
  if (e instanceof URIError) {
    return Promise.resolve({
      status: 400,
      body: encoder.encode("Bad Request"),
    });
  } else if (e instanceof Deno.errors.NotFound) {
    const url = normalizeURL(req.url);
    if (
      basename(fsPath) !== "favicon.ico" && extname(fsPath) !== ".map" &&
      !basename(fsPath).startsWith("jupyter-")
    ) {
      if (options.debug) {
        printUrl(url, false);
      }
    }
    return Promise.resolve({
      status: 404,
      body: encoder.encode("Not Found"),
    });
  } else {
    if (!options.quiet) {
      message(`500 (Internal Error): ${(e as Error).message}`, { bold: true });
    }
    if (options.debug) {
      console.error(e);
    }
    return Promise.resolve({
      status: 500,
      body: encoder.encode("Internal server error"),
    });
  }
}

async function serveFile(
  filePath: string,
  watcher: ProjectWatcher,
  projServe?: ProjectServe,
): Promise<Response> {
  // alias project
  const project = watcher.project();

  // read file
  let fileContents = new Uint8Array();

  // if this is an html file then append watch script and allow any projServe filter to run
  if (existsSync(filePath) && isHtmlContent(filePath)) {
    // if the output file is < 1 second old we don't re-render
    const fileTime = Deno.statSync(filePath).mtime;
    if (!fileTime || ((Date.now() - fileTime.getTime()) > 1000)) {
      // find the input file associated with this output and render it
      // if we can't find an input file for this .html file it may have
      // been an input added after the server started running, to catch
      // this case run a refresh on the watcher then try again
      let inputFile = await inputFileForOutputFile(project, filePath);
      if (!inputFile) {
        inputFile = await inputFileForOutputFile(watcher.refresh(), filePath);
      }
      if (inputFile) {
        await renderProject(
          project,
          { useFreezer: true, flags: { quiet: true } },
          [inputFile],
        );
      }
    }

    fileContents = Deno.readFileSync(filePath);
    fileContents = watcher.injectClient(fileContents);
    if (projServe?.htmlFilter) {
      fileContents = projServe.htmlFilter(project, filePath, fileContents);
    }
  } else {
    fileContents = Deno.readFileSync(filePath);
  }

  // content headers
  const headers = new Headers();
  headers.set("Content-Length", fileContents.byteLength.toString());
  const contentTypeValue = contentType(filePath);
  if (contentTypeValue) {
    headers.set("Content-Type", contentTypeValue);
  }
  headers.set("Cache-Control", "no-store, max-age=0");

  return {
    status: 200,
    body: fileContents,
    headers,
  };
}

function printUrl(url: string, found = true) {
  const format = !found ? colors.red : undefined;
  url = url + (found ? "" : " (404: Not Found)");
  if (
    isHtmlContent(url) || url.endsWith("/") || extname(url) === ""
  ) {
    message(`\nGET: ${url}`, { bold: true, format: format || colors.green });
  } else {
    message(url, { dim: found, format, indent: 1 });
  }
}

function normalizeURL(url: string): string {
  let normalizedUrl = url;
  try {
    normalizedUrl = decodeURI(normalizedUrl);
  } catch (e) {
    if (!(e instanceof URIError)) {
      throw e;
    }
  }

  try {
    //allowed per https://www.w3.org/Protocols/rfc2616/rfc2616-sec5.html
    const absoluteURI = new URL(normalizedUrl);
    normalizedUrl = absoluteURI.pathname;
  } catch (e) { //wasn't an absoluteURI
    if (!(e instanceof TypeError)) {
      throw e;
    }
  }

  if (normalizedUrl[0] !== "/") {
    throw new URIError("The request URI is malformed.");
  }

  normalizedUrl = posix.normalize(normalizedUrl);
  const startOfParams = normalizedUrl.indexOf("?");
  return startOfParams > -1
    ? normalizedUrl.slice(0, startOfParams)
    : normalizedUrl;
}
