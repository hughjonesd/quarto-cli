/*
* parsing.ts
* 
* Copyright (C) 2022 by RStudio, PBC
*
*/

import { getLocalPath } from "./paths.ts";
import { MappedString, mappedString, asMappedString } from "../mapped-text.ts";
import { rangedLines } from "../ranged-text.ts";
import { lines, rowColToIndex } from "../text.ts";
import { YamlIntelligenceContext, LocateFromIndentationContext } from "./types.ts";

let _parser: any;

interface WithTreeSitter {
  TreeSitter: any;
}

// this is an escape hatch for quarto's CLI to operate
// the yaml-intelligence code outside of the IDE
export async function setTreeSitter(parser: any) {
  _parser = parser;
}

export async function getTreeSitter(): Promise<any> {
  if (_parser) {
    return _parser;
  }

  // this is super ugly and probably will break on the test suite...
  const Parser = ((window as unknown) as WithTreeSitter).TreeSitter;

  await Parser.init();

  _parser = new Parser();

  // FIXME check if this shouldn't be parameterized somehow.
  const YAML = await Parser.Language.load(
    getLocalPath("tree-sitter-yaml.wasm")
  );

  _parser.setLanguage(YAML);
  return _parser;
}

export interface ParseAttemptResult {
  code: MappedString,
  parse: any,
  deletions: number
};

export function* attemptParsesAtLine(context: YamlIntelligenceContext, parser: any): Generator<ParseAttemptResult> {
  let {
    position // row/column of cursor (0-based)
  } = context;

  // full contents of the buffer
  const code = asMappedString(context.code);

  try {
    const tree = parser.parse(code.value);
    if (tree.rootNode.type !== "ERROR") {
      yield {
        parse: tree,
        code,
        deletions: 0,
      };
    }
  } catch (_e) {
    // bail on internal error from tree-sitter.
    return;
  }

  const codeLines = rangedLines(code.value, true);

  // in markdown files, we are passed chunks of text one at a time, and
  // sometimes the cursor lies outside those chunks. In that case, we cannot
  // attempt to fix the parse by deleting character, and so we simply bail.
  if (position.row >= codeLines.length || position.row < 0) {
    return;
  }

  const currentLine = codeLines[position.row].substring;
  let currentColumn = position.column;
  let deletions = 0;
  const locF = rowColToIndex(code.value);

  while (currentColumn > 0) {
    currentColumn--;
    deletions++;

    const chunks = [];
    if (position.row > 0) {
      chunks.push({
        start: 0,
        end: codeLines[position.row - 1].range.end,
      });
    }

    if (position.column > deletions) {
      chunks.push({
        start: locF({ row: position.row, column: 0 }),
        end: locF({ row: position.row, column: position.column - deletions }),
      });
    }

    if (position.row + 1 < codeLines.length) {
      chunks.push({
        start: locF({ row: position.row, column: currentLine.length - 1 }),
        end: locF({ row: position.row + 1, column: 0 }),
      });
      chunks.push({
        start: codeLines[position.row + 1].range.start,
        end: codeLines[codeLines.length - 1].range.end,
      });
    }
    const newCode = mappedString(code, chunks);

    const tree = parser.parse(newCode.value);
    if (tree.rootNode.type !== "ERROR") {
      yield {
        parse: tree,
        code: newCode,
        deletions,
      };
    }
  }
}

function getIndent(l: string) {
  return l.length - l.trimStart().length;
}

export function getYamlIndentTree(code: string) {
  const ls = lines(code);
  const predecessor: number[] = [];
  const indents: number[] = [];

  let indentation = -1;
  let prevPredecessor = -1;
  for (let i = 0; i < ls.length; ++i) {
    const line = ls[i];
    const lineIndent = getIndent(line);
    indents.push(lineIndent);

    if (lineIndent > indentation) {
      predecessor[i] = prevPredecessor;
      prevPredecessor = i;
      indentation = lineIndent;
    } else if (line.trim().length === 0) {
      predecessor[i] = predecessor[prevPredecessor];
    } else if (lineIndent === indentation) {
      predecessor[i] = predecessor[prevPredecessor];
      prevPredecessor = i;
    } else if (lineIndent < indentation) {
      // go down the predecessor relation
      let v = prevPredecessor;
      while (v >= 0 && indents[v] >= lineIndent) {
        v = predecessor[v];
      }
      predecessor[i] = v;
      prevPredecessor = i;
      indentation = lineIndent;
    } else {
      throw new Error("Internal error, should never have arrived here");
    }
  }
  return {
    predecessor,
    indentation: indents,
  };
}

export function locateFromIndentation(context: LocateFromIndentationContext): (number | string)[] {
  let {
    line, // editing line up to the cursor
    code: mappedCode, // full contents of the buffer
    position, // row/column of cursor (0-based)
  } = context;

  // currently we don't need mappedstrings here, so we cast to string
  const code = asMappedString(mappedCode).value;

  const { predecessor, indentation } = getYamlIndentTree(code);

  const ls = lines(code);
  let lineNo = position.row;
  const path = [];
  const lineIndent = getIndent(line);
  while (lineNo !== -1) {
    const trimmed = ls[lineNo].trim();

    // treat whitespace differently: find first non-whitespace line above it and compare indents
    if (trimmed.length === 0) {
      let prev = lineNo;
      while (prev >= 0 && ls[prev].trim().length === 0) {
        prev--;
      }
      if (prev === -1) {
        // all whitespace..?! we give up.
        break;
      }
      const prevIndent = getIndent(ls[prev]);
      if (prevIndent < lineIndent) {
        // we're indented deeper than the previous indent: Locate through that.
        lineNo = prev;
        continue;
      }
    }
    if (lineIndent >= indentation[lineNo]) {
      if (trimmed.startsWith("-")) {
        // sequence entry
        // we report the wrong number here, but since we don't
        // actually need to know which entry in the array this is in
        // order to navigate the schema, this is fine.
        path.push(0);
      } else if (trimmed.endsWith(":")) {
        // mapping
        path.push(trimmed.substring(0, trimmed.length - 1));
      } else if (trimmed.length !== 0) {
        // parse error?
        throw new Error("Internal error: this shouldn't have happened");
      }
    }
    lineNo = predecessor[lineNo];
  }
  path.reverse();
  return path;
}
