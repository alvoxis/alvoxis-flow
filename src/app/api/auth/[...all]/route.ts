import { getAuth } from "@/server/auth/instance";

export const dynamic = "force-dynamic";

const handler = (request: Request) => getAuth().handler(request);

export { handler as GET, handler as POST };
