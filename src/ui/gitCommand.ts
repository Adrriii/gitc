/**
 * The git subcommand a recorded call belongs to.
 *
 * The first argument that is not a flag: "log --branches ..." is log, and
 * "status" is status. What gitc adds for its own purposes has already been
 * stripped from the recorded arguments by the engine, so what is left is what
 * someone would have typed - and the first word of that is the command.
 *
 * Its own module rather than part of settings.ts, which imports React and so
 * cannot be loaded by a plain Node test.
 */
export function commandType(args: string): string {
  for (const part of args.split(" ")) {
    if (part.length > 0 && !part.startsWith("-")) return part;
  }
  return args;
}
