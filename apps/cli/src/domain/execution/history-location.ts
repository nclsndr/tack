import { posixPath } from "../identity/portable.ts";

/** Locates retained run history inside one state directory; deleting state removes it too. */
export const historyDirectory = (stateDirectory: string) =>
  posixPath.join(stateDirectory, "history");
