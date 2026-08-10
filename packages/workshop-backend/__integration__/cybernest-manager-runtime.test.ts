import { exports } from "cloudflare:workers";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { AuthenticatedApi, GadgetMetadataWithTimestamps } from "@gadgets/workshop-shared/api";
import { describe, expect, it } from "vitest";

type Session = {
  api: RpcStub<AuthenticatedApi>;
  socket: WebSocket;
};

const managerId = (): string => crypto.randomUUID();

const managerHeaders = (id: string): HeadersInit => ({
  "X-Cybernest-Manager-Id": id,
});

async function managerRequest(
    path: string, method: "GET" | "POST", id?: string): Promise<Response> {
  const headers = id === undefined ? undefined : managerHeaders(id);
  return exports.default.fetch(new Request(`https://workshop.invalid${path}`, {method, headers}));
}

async function ensure(id: string): Promise<void> {
  const response = await managerRequest("/_cybernest/manager", "POST", id);
  expect(response.status).toBe(204);
}

async function read(id: string): Promise<Response> {
  return managerRequest("/_cybernest/manager", "GET", id);
}

async function connect(id: string): Promise<Session> {
  const response = await exports.default.fetch(new Request("https://workshop.invalid/api", {
    headers: {
      Upgrade: "websocket",
      ...managerHeaders(id),
    },
  }));

  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new TypeError("Expected a WebSocket response.");

  socket.accept();
  return {
    socket,
    api: newWebSocketRpcSession<AuthenticatedApi>(socket),
  };
}

function close(session: Session): void {
  session.api[Symbol.dispose]();
  session.socket.close();
}

async function waitForGadget(
    api: RpcStub<AuthenticatedApi>, id: string): Promise<GadgetMetadataWithTimestamps> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const gadget = (await api.listGadgets()).find(item => item.id === id);
    if (gadget) return gadget;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for Gadget ${id}.`);
}

describe("Cybernest Manager runtime", () => {
  it("ensures one manager profile, isolates A/B state, and reconnects to A", async () => {
    const managerA = managerId();
    const managerB = managerId();

    expect((await read(managerA)).status).toBe(404);
    await ensure(managerA);
    await ensure(managerA);
    expect((await read(managerA)).status).toBe(204);

    const sessionA = await connect(managerA);
    let gadgetId: string;
    try {
      await expect(sessionA.api.whoami()).resolves.toMatchObject({
        type: "user",
        id: managerA,
      });

      const workspace = await sessionA.api.newGadget();
      try {
        const metadata = await workspace.getMetadata();
        gadgetId = metadata.id;
        await workspace.updateCode(new Uint8Array());
      } finally {
        workspace[Symbol.dispose]();
      }

      await expect(waitForGadget(sessionA.api, gadgetId)).resolves.toMatchObject({
        id: gadgetId,
      });
    } finally {
      close(sessionA);
    }

    await ensure(managerB);
    const sessionB = await connect(managerB);
    try {
      await expect(sessionB.api.whoami()).resolves.toMatchObject({
        type: "user",
        id: managerB,
      });
      await expect(sessionB.api.listGadgets()).resolves.not.toContainEqual(
          expect.objectContaining({id: gadgetId!}));
    } finally {
      close(sessionB);
    }

    const reconnectedA = await connect(managerA);
    try {
      await expect(reconnectedA.api.whoami()).resolves.toMatchObject({id: managerA});
      await expect(waitForGadget(reconnectedA.api, gadgetId!)).resolves.toMatchObject({
        id: gadgetId,
      });
    } finally {
      close(reconnectedA);
    }
  });

  it("rejects missing or malformed private context without opening the OS API", async () => {
    const knownManager = managerId();
    expect((await managerRequest("/_cybernest/manager", "GET")).status).toBe(400);
    expect((await managerRequest("/_cybernest/manager", "POST")).status).toBe(400);
    expect((await managerRequest("/_cybernest/manager", "GET", "not-a-uuid")).status)
        .toBe(400);

    const malformedApi = await exports.default.fetch(new Request("https://workshop.invalid/api", {
      headers: {
        Upgrade: "websocket",
        ...managerHeaders("not-a-uuid"),
      },
    }));
    expect(malformedApi.status).toBe(400);
    expect(malformedApi.webSocket).toBeNull();

    expect((await managerRequest("/_cybernest/manager/other", "GET", knownManager)).status)
        .toBe(404);

    const noManagerApi = await exports.default.fetch(new Request("https://workshop.invalid/api", {
      headers: {Upgrade: "websocket"},
    }));
    expect(noManagerApi.status).toBe(400);
    expect(noManagerApi.webSocket).toBeNull();

    const publicRoot = await exports.default.fetch(new Request("https://workshop.invalid/"));
    expect(publicRoot.status).toBe(404);
  });
});
