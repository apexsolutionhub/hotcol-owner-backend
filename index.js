import express from "express";
import { ApolloServer } from "apollo-server-express";
import cors from "cors";
import "dotenv/config";
import { typeDefs } from "./typeDefs.js";
import { resolvers } from "./resolvers.js";
import { authenticateOwner } from "./lib/auth.js";
import { prisma } from "./lib/prisma.js";

function assertPrismaOwnerModel() {
  if (!prisma.owner_account?.findUnique) {
    throw new Error(
      "[HotCol Owner API] Prisma client is out of date — owner_account is missing. Run `npm run prisma:generate` in BackEnd.",
    );
  }
}

assertPrismaOwnerModel();

const app = express();
app.use(cors({ origin: true, credentials: true }));

const server = new ApolloServer({
  typeDefs,
  resolvers,
  context: ({ req }) => ({
    owner: authenticateOwner(req),
  }),
});

await server.start();
server.applyMiddleware({
  app,
  path: "/graphql",
  bodyParserConfig: { limit: "2mb" },
});

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "OK",
    service: "HotCol Owner GraphQL API",
    timestamp: new Date().toISOString(),
  });
});

app.get("/", (_req, res) => {
  res.status(200).json({
    status: "OK",
    service: "HotCol Owner GraphQL API",
    graphql: "/graphql",
    health: "/health",
  });
});

/** Required for Vercel serverless — do not call app.listen() there. */
export default app;

if (!process.env.VERCEL) {
  const port = process.env.PORT || 4001;
  app.listen(port, () => {
    console.log(`Owner API ready at http://localhost:${port}/graphql`);
    console.log("Prisma: run `npm run prisma:generate` after schema changes");
  });
}
