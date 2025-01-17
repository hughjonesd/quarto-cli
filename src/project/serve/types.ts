/*
* types.ts
*
* Copyright (C) 2020 by RStudio, PBC
*
*/

import { FileResponse } from "../../core/http.ts";
import { ProjectContext } from "../../project/types.ts";

export interface ProjectWatcher {
  handle: (req: Request) => boolean;
  connect: (req: Request) => Promise<Response | undefined>;
  injectClient: (
    file: Uint8Array,
    inputFile?: string,
  ) => FileResponse;
  hasClients: () => boolean;
  project: () => ProjectContext;
  serveProject: () => ProjectContext;
  refreshProject: () => Promise<ProjectContext>;
}

export type ServeOptions = {
  port: number;
  host: string;
  render: string;
  timeout: number;
  browse: boolean;
  browserPath?: string;
  watchInputs?: boolean;
  navigate?: boolean;
};
