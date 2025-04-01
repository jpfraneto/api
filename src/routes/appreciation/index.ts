import { Hono } from "hono";
import {
  ParseWebhookEvent,
  parseWebhookEvent,
  verifyAppKeyWithNeynar,
  SendNotificationRequest,
  sendNotificationResponseSchema,
} from "@farcaster/frame-node";
import * as fs from "fs/promises";
import * as path from "path";
import * as cron from "node-cron";
import { randomUUID } from "crypto";
import { readdir } from "fs/promises";

// Initialize app and set up directories only once
const appreciationApp = new Hono();
const appreciationDir = path.join(process.cwd(), "data", "appreciation");

// Type definitions
interface NotificationDetails {
  url: string;
  token: string;
  enabled: boolean;
  lastUpdated: number;
}

interface NotificationStore {
  [key: string]: NotificationDetails;
}

type SendFrameNotificationResult =
  | { state: "error"; error: unknown }
  | { state: "no_token" }
  | { state: "rate_limit" }
  | { state: "success" };

// Helper functions
async function getUserNotificationDetails(
  fid: number
): Promise<NotificationDetails | null> {
  try {
    const userDir = path.join(appreciationDir, fid.toString());
    const notificationFile = path.join(userDir, "notifications.json");

    try {
      await fs.access(userDir);
      await fs.access(notificationFile);
    } catch {
      return null;
    }

    const data = await fs.readFile(notificationFile, "utf8");
    const notifications: NotificationStore = JSON.parse(data);
    return notifications[fid] || null;
  } catch (err) {
    console.error(`Error getting notification details for FID ${fid}:`, err);
    return null;
  }
}

async function sendFrameNotification({
  fid,
  title,
  body,
  notificationDetails,
}: {
  fid: number;
  title: string;
  body: string;
  notificationDetails?: NotificationDetails;
}): Promise<SendFrameNotificationResult> {
  const details =
    notificationDetails || (await getUserNotificationDetails(fid));
  if (!details) {
    return { state: "no_token" };
  }

  try {
    const response = await fetch(details.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        notificationId: randomUUID(),
        title,
        body,
        targetUrl: "https://appreciation.lat",
        tokens: [details.token],
      } satisfies SendNotificationRequest),
    });

    const responseJson = await response.json();

    if (response.status === 200) {
      const responseBody =
        sendNotificationResponseSchema.safeParse(responseJson);
      if (responseBody.success === false) {
        return { state: "error", error: responseBody.error.errors };
      }

      if (responseBody.data.result.rateLimitedTokens.length) {
        return { state: "rate_limit" };
      }

      return { state: "success" };
    } else {
      return { state: "error", error: responseJson };
    }
  } catch (err) {
    return { state: "error", error: err };
  }
}

async function getAllUserNotifications(): Promise<
  Map<number, NotificationDetails>
> {
  const notifications = new Map<number, NotificationDetails>();
  try {
    const userDirs = await readdir(appreciationDir);

    for (const fidDir of userDirs) {
      const fid = parseInt(fidDir);
      if (isNaN(fid)) continue;

      const details = await getUserNotificationDetails(fid);
      if (details?.enabled) {
        notifications.set(fid, details);
      }
    }
  } catch (err) {
    console.error("Error reading user notifications:", err);
  }
  return notifications;
}

// Set up cron job with rate limiting
let isJobRunning = false;

async function sendDailyAppreciationReminders() {
  if (isJobRunning) {
    console.log("Previous job still running, skipping...");
    return;
  }

  try {
    isJobRunning = true;
    const users = await getAllUserNotifications();

    for (const [fid, details] of Array.from(users.entries())) {
      try {
        const result = await sendFrameNotification({
          fid,
          title: "Daily Appreciation Reminder",
          body: "This is your daily reminder to appreciate something!",
          notificationDetails: details,
        });

        if (result.state === "rate_limit") {
          console.log(
            `Rate limited for FID ${fid}, skipping remaining notifications`
          );
          break;
        }
      } catch (err) {
        console.error(`Failed to send reminder to FID ${fid}:`, err);
      }

      // Add delay between notifications
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } finally {
    isJobRunning = false;
  }
}

// Schedule cron job
cron.schedule("0 0 * * *", sendDailyAppreciationReminders);

// Routes
appreciationApp.post("/cast-appreciation", async (c) => {
  const { fid, token, text } = await c.req.json();
  return c.json({ success: true });
});

appreciationApp.post("/frames-webhook", async (c) => {
  try {
    const requestJson = await c.req.json();

    const neynarEnabled =
      process.env.NEYNAR_API_KEY && process.env.NEYNAR_CLIENT_ID;
    if (!neynarEnabled) {
      return c.json({
        success: true,
        message: "Neynar is not enabled, skipping webhook processing",
      });
    }

    let data;
    try {
      data = await parseWebhookEvent(requestJson, verifyAppKeyWithNeynar);
    } catch (e) {
      const error = e as ParseWebhookEvent.ErrorType;

      switch (error.name) {
        case "VerifyJsonFarcasterSignature.InvalidDataError":
        case "VerifyJsonFarcasterSignature.InvalidEventDataError":
          return c.json({ success: false, error: error.message }, 400);
        case "VerifyJsonFarcasterSignature.InvalidAppKeyError":
          return c.json({ success: false, error: error.message }, 401);
        case "VerifyJsonFarcasterSignature.VerifyAppKeyError":
          return c.json({ success: false, error: error.message }, 500);
      }
    }

    const fid = data.fid;
    const event = data.event;

    // Create user directory
    const userDir = path.join(appreciationDir, fid.toString());
    await fs.mkdir(userDir, { recursive: true });

    // Handle notifications
    const notificationFile = path.join(userDir, "notifications.json");

    let notifications: NotificationStore = {};
    try {
      const existing = await fs.readFile(notificationFile, "utf8");
      notifications = JSON.parse(existing);
    } catch (err) {
      // File doesn't exist yet, use empty object
    }

    let notificationDetails: NotificationDetails | null = null;

    switch (event.event) {
      case "frame_added":
        if (event.notificationDetails) {
          notificationDetails = {
            url: event.notificationDetails.url,
            token: event.notificationDetails.token,
            enabled: true,
            lastUpdated: Date.now(),
          };
          notifications[fid] = notificationDetails;

          await fs.writeFile(
            notificationFile,
            JSON.stringify(notifications, null, 2)
          );

          await sendFrameNotification({
            fid,
            title: "Welcome to Appreciation",
            body: "Thanks for adding the frame. You'll receive a daily reminder to appreciate something.",
            notificationDetails,
          });
        }
        break;

      case "frame_removed":
        delete notifications[fid];
        break;

      case "notifications_enabled":
        notificationDetails = {
          url: event.notificationDetails.url,
          token: event.notificationDetails.token,
          enabled: true,
          lastUpdated: Date.now(),
        };
        notifications[fid] = notificationDetails;
        break;

      case "notifications_disabled":
        if (notifications[fid]) {
          notifications[fid].enabled = false;
          notifications[fid].lastUpdated = Date.now();
        }
        break;
    }

    await fs.writeFile(
      notificationFile,
      JSON.stringify(notifications, null, 2)
    );

    return c.json({
      success: true,
      message: `Successfully processed ${event.event} event for FID ${fid}`,
    });
  } catch (error) {
    console.error("Error processing webhook:", error);
    if (error instanceof Error) {
      return c.json({ success: false, error: error.message }, 500);
    }
    return c.json({ success: false, error: "An unknown error occurred" }, 500);
  }
});

appreciationApp.get("/transform-gratitude-into-aiagent", async (c) => {
  return c.json({
    success: true,
    message: "Hello, world!",
  });
});

export default appreciationApp;
