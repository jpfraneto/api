import { Hono } from "hono";

// ROUTES
import appreciation from "./routes/appreciation";

const app = new Hono();

app.get("/", (c) => {
  return c.text("Hello api.anky.bot!");
});

app.route("/appreciation", appreciation);

export default app;
