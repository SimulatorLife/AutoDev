import { redirect } from "next/navigation";

export default function ConsoleRootPage(): never {
  redirect("/agents");
}
