/**
 * Path patterns for proofwright/config.json. Supported: `*` (within one path
 * segment), `?` (one character, not `/`), `**` (any number of segments). A
 * pattern with no wildcard, or one ending in `/**`, matches that path and
 * everything under it, so `demo/answer-key` keeps the whole folder out.
 */
export function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (g.endsWith("/**")) return new RegExp(`^${convert(g.slice(0, -3))}(?:/.*)?$`);
  if (!/[*?]/.test(g)) return new RegExp(`^${escape(g)}(?:/.*)?$`);
  return new RegExp(`^${convert(g)}$`);
}

function convert(g: string): string {
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      re += ".*";
      i++;
      if (g[i + 1] === "/") i++;
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += escape(c);
    }
  }
  return re;
}

function escape(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}
