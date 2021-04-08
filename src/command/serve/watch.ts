/*
* watch.ts
*
* Copyright (C) 2020 by RStudio, PBC
*
*/

import { ServerRequest } from "http/server.ts";

import { extname, join, relative } from "path/mod.ts";
import { existsSync } from "fs/mod.ts";

import { acceptWebSocket, WebSocket } from "ws/mod.ts";

import { ld } from "lodash/mod.ts";

import { pathWithForwardSlashes } from "../../core/path.ts";

import {
  kLibDir,
  ProjectContext,
  projectContext,
  projectOutputDir,
} from "../../project/project-context.ts";

import { resolveInputTarget } from "../../project/project-index.ts";

import { fileExecutionEngine } from "../../execute/engine.ts";

import { RenderResult } from "../render/render.ts";

import {
  copyProjectForServe,
  kLocalhost,
  maybeDisplaySocketError,
  ServeOptions,
} from "./serve.ts";
import { logError } from "../../core/log.ts";

export interface ProjectWatcher {
  handle: (req: ServerRequest) => boolean;
  connect: (req: ServerRequest) => Promise<void>;
  injectClient: (file: Uint8Array) => Uint8Array;
  serveProject: () => ProjectContext;
  refreshProject: () => ProjectContext;
}

export function watchProject(
  project: ProjectContext,
  serveProject: ProjectContext,
  renderResult: RenderResult,
  options: ServeOptions,
): ProjectWatcher {
  // proj dir
  const projDir = Deno.realPathSync(project.dir);
  const projDirHidden = projDir + "/.";

  // output dir
  const outputDir = projectOutputDir(project);

  // lib dir
  const libDirConfig = project.metadata?.project?.[kLibDir];
  const libDir = libDirConfig ? join(outputDir, libDirConfig) : undefined;

  // if any of the paths are in the output dir (but not the lib dir) then return true
  const inOutputDir = (path: string) => {
    if (path.startsWith(outputDir)) {
      // exclude lib dir
      if (libDir && path.startsWith(libDir)) {
        return false;
      } else {
        return true;
      }
    } else {
      return false;
    }
  };

  // is this a resource file?
  const isResourceFile = (path: string) => {
    if (renderResult) {
      if (project.files.resources?.includes(path)) {
        return true;
      } else {
        return renderResult.files.some((file) =>
          file.resourceFiles.includes(path)
        );
      }
    } else {
      return false;
    }
  };

  // is this a renderOnChange input file?
  const isRenderOnChangeInput = (path: string) => {
    if (project.files.input.includes(path) && existsSync(path)) {
      const engine = fileExecutionEngine(path, true);
      return engine && !!engine.renderOnChange;
    }
  };

  // track every path that has been modified since the last reload
  const modified: string[] = [];

  // handle a watch event (return true if a reload should occur)
  const handleWatchEvent = (event: Deno.FsEvent): boolean | "config" => {
    try {
      if (["modify", "create"].includes(event.kind)) {
        // filter out paths in hidden folders (e.g. .quarto, .git, .Rproj.user)
        const paths = ld.uniq(
          event.paths.filter((path) => !path.startsWith(projDirHidden)),
        );

        // request reload (debounced) for any change
        if (paths.length > 0) {
          // note modified
          modified.push(...paths);

          const configFile = paths.some((path) =>
            (project.files.config || []).includes(path)
          );
          const configResourceFile = paths.some((path) =>
            (project.files.configResources || []).includes(path)
          );
          const resourceFile = paths.some(isResourceFile);

          const outputDirFile = paths.some(inOutputDir);

          const renderOnChangeInput = paths.some(isRenderOnChangeInput);

          const reload = configFile || configResourceFile || resourceFile ||
            outputDirFile || renderOnChangeInput;

          if (reload) {
            if (configFile) {
              return "config";
            } else {
              return true;
            }
          } else {
            return false;
          }
        } else {
          return false;
        }
      } else {
        return false;
      }
    } catch (e) {
      logError(e);
      return false;
    }
  };

  // track clients
  interface Client {
    path: string;
    socket: WebSocket;
  }
  const clients: Client[] = [];

  // debounced function for notifying all clients of a change
  // (ensures that we wait for bulk file copying to complete
  // before triggering the reload)
  const reloadClients = ld.debounce(async (refreshProject: boolean) => {
    // copy the project (refresh if requested)
    copyProjectForServe(project, serveProject.dir);
    if (refreshProject) {
      serveProject = projectContext(serveProject.dir);
    }

    // see if there is a reload target (last html file modified)
    const lastHtmlFile = ld.uniq(modified).reverse().find((file) => {
      return extname(file) === ".html";
    });
    let reloadTarget = "";
    if (lastHtmlFile && options.navigate) {
      if (lastHtmlFile.startsWith(outputDir)) {
        reloadTarget = relative(outputDir, lastHtmlFile);
      } else {
        reloadTarget = relative(projDir, lastHtmlFile);
      }
      if (existsSync(join(outputDir, reloadTarget))) {
        reloadTarget = "/" + pathWithForwardSlashes(reloadTarget);
      } else {
        reloadTarget = "";
      }
    }
    // if we don't have a reload target based on html output, see if we can
    // get one from a reloadOnChange input
    const input = modified.find(isRenderOnChangeInput);
    if (input) {
      const target = await resolveInputTarget(
        project,
        relative(project.dir, input),
      );
      if (target) {
        reloadTarget = target.outputHref;
      }
    }

    // clear out the modified list
    modified.splice(0, modified.length);

    for (let i = clients.length - 1; i >= 0; i--) {
      const socket = clients[i].socket;
      try {
        await socket.send(`reload${reloadTarget}`);
      } catch (e) {
        maybeDisplaySocketError(e);
      } finally {
        if (!socket.isClosed) {
          socket.close().catch(maybeDisplaySocketError);
        }
        clients.splice(i, 1);
      }
    }
  }, 100);

  // watch project dir recursively
  const watcher = Deno.watchFs(project.dir, { recursive: true });
  const watchForChanges = () => {
    watcher.next().then(async (iter) => {
      try {
        // see if we need to handle this
        const result = handleWatchEvent(iter.value);
        if (result) {
          await reloadClients(result === "config");
        }
      } catch (e) {
        logError(e);
      } finally {
        watchForChanges();
      }
    });
  };
  watchForChanges();

  // return watcher interface
  return {
    handle: (req: ServerRequest) => {
      return !!options.watch && (req.headers.get("upgrade") === "websocket");
    },
    connect: async (req: ServerRequest) => {
      const { conn, r: bufReader, w: bufWriter, headers } = req;
      try {
        const socket = await acceptWebSocket({
          conn,
          bufReader,
          bufWriter,
          headers,
        });
        clients.push({ path: req.url, socket });
      } catch (e) {
        maybeDisplaySocketError(e);
      }
    },
    injectClient: (file: Uint8Array) => {
      if (options.watch) {
        const scriptContents = new TextEncoder().encode(
          watchClientScript(options.port),
        );
        const fileWithScript = new Uint8Array(
          file.length + scriptContents.length,
        );
        fileWithScript.set(file);
        fileWithScript.set(scriptContents, file.length);
        return fileWithScript;
      } else {
        return file;
      }
    },
    serveProject: () => serveProject,
    refreshProject: () => {
      serveProject = projectContext(serveProject.dir);
      return serveProject;
    },
  };
}

function watchClientScript(port: number): string {
  return `
<script>
  const socket = new WebSocket('ws://${kLocalhost}:${port}' + window.location.pathname );
  socket.onopen = () => {
    console.log('Socket connection open. Listening for events.');
  };
  socket.onmessage = (msg) => {
    if (msg.data.startsWith('reload')) {
      socket.close();
      const target = msg.data.replace(/^reload/, "");
      if (target && (target !== window.location.pathname)) {
        window.location.replace(target.replace(/index\.html$/, ""))
      } else {
        window.location.reload(true);
      }
    } 
  };
</script>`;
}
