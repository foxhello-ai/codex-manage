import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { SmtpEmailVerificationNotifier } from "./notifier";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
});

describe("SmtpEmailVerificationNotifier", () => {
  it("sends an email verification code through SMTP", async () => {
    const received = await startFakeSmtpServer();
    const port = (received.server.address() as { port: number }).port;
    const notifier = new SmtpEmailVerificationNotifier({
      host: "127.0.0.1",
      port,
      secure: false,
      user: "ericoto@163.com",
      password: "smtp-password",
      fromEmail: "ericoto@163.com",
      fromName: "ericoto"
    });

    await notifier.send({
      type: "email",
      identifier: "user@example.com",
      code: "123456",
      purpose: "register",
      expiresAt: "2026-07-31T10:00:00.000Z"
    });

    expect(received.commands).toEqual(expect.arrayContaining([
      "AUTH LOGIN",
      Buffer.from("ericoto@163.com").toString("base64"),
      Buffer.from("smtp-password").toString("base64"),
      "MAIL FROM:<ericoto@163.com>",
      "RCPT TO:<user@example.com>",
      "DATA"
    ]));
    expect(received.message).toContain("From: =?UTF-8?B?ZXJpY290bw==?= <ericoto@163.com>");
    expect(received.message).toContain("To: <user@example.com>");
    expect(received.message).toContain("您的 Codex Manage 验证码是：123456");
  });
});

async function startFakeSmtpServer(): Promise<{ server: Server; commands: string[]; message: string }> {
  const state = { commands: [] as string[], message: "" };
  const server = createServer((socket) => handleSmtpConnection(socket, state));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    commands: state.commands,
    get message() {
      return state.message;
    }
  };
}

function handleSmtpConnection(socket: Socket, state: { commands: string[]; message: string }): void {
  socket.setEncoding("utf8");
  socket.write("220 fake-smtp.local ESMTP\r\n");
  let buffer = "";
  let dataMode = false;
  const messageLines: string[] = [];

  socket.on("data", (chunk) => {
    buffer += String(chunk);
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      if (dataMode) {
        if (line === ".") {
          state.message = messageLines.join("\n");
          dataMode = false;
          socket.write("250 queued\r\n");
          continue;
        }
        messageLines.push(line);
        continue;
      }
      state.commands.push(line);
      if (line.startsWith("EHLO")) socket.write("250 fake-smtp.local\r\n");
      else if (line === "AUTH LOGIN") socket.write("334 VXNlcm5hbWU6\r\n");
      else if (line === Buffer.from("ericoto@163.com").toString("base64")) socket.write("334 UGFzc3dvcmQ6\r\n");
      else if (line === Buffer.from("smtp-password").toString("base64")) socket.write("235 authenticated\r\n");
      else if (line.startsWith("MAIL FROM:")) socket.write("250 ok\r\n");
      else if (line.startsWith("RCPT TO:")) socket.write("250 ok\r\n");
      else if (line === "DATA") {
        dataMode = true;
        socket.write("354 end with dot\r\n");
      } else if (line === "QUIT") {
        socket.write("221 bye\r\n");
        socket.end();
      } else {
        socket.write("500 unsupported\r\n");
      }
    }
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
