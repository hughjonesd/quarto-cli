/*
* capabilities.ts
*
* Copyright (C) 2020 by RStudio, PBC
*
*/

import { basename, join } from "path/mod.ts";

import { ld } from "lodash/mod.ts";
import { formatResourcePath } from "../../core/resources.ts";

import { pandocListFormats } from "../../core/pandoc/pandoc-formats.ts";
import {
  JupyterCapabilities,
  jupyterCapabilities,
} from "../../core/jupyter/capabilities.ts";

export interface Capabilities {
  formats: string[];
  themes: string[];
  python?: JupyterCapabilities;
}

export async function capabilities(): Promise<Capabilities> {
  return {
    formats: await formats(),
    themes: await themes(),
    python: await jupyterCapabilities(),
  };
}

async function formats() {
  const formats = await pandocListFormats();

  const commonFormats = [
    "html",
    "pdf",
    "docx",
    "odt",
    "pptx",
    "beamer",
    "revealjs",
    "gfm",
    "hugo",
    "epub",
  ];

  const excludedFormats = [
    "bibtex",
    "biblatex",
    "csljson",
  ];

  return ld.difference(
    commonFormats.concat(ld.difference(formats, commonFormats)),
    excludedFormats,
  );
}

async function themes() {
  const themesPath = formatResourcePath("html", join("bootstrap", "themes"));
  const themes: string[] = ["default"];
  const kScss = ".scss";
  for await (const dirEntry of Deno.readDir(themesPath)) {
    if (dirEntry.isFile && dirEntry.name.endsWith(kScss)) {
      themes.push(basename(dirEntry.name, kScss));
    }
  }
  return themes;
}
