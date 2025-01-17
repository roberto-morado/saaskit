// Copyright 2023 the Deno authors. All rights reserved. MIT license.

import { createHandler, Status } from "$fresh/server.ts";
import manifest from "@/fresh.gen.ts";
import {
  collectValues,
  type Comment,
  createComment,
  createItem,
  createNotification,
  createUser,
  createVote,
  ifUserHasNotifications,
  type Item,
  kv,
  listCommentsByItem,
  type Notification,
} from "@/utils/db.ts";
import {
  genNewComment,
  genNewItem,
  genNewNotification,
  genNewUser,
} from "@/utils/db_test.ts";
import { stripe } from "@/utils/stripe.ts";
import {
  assert,
  assertArrayIncludes,
  assertEquals,
  assertFalse,
  assertInstanceOf,
  assertNotEquals,
  assertObjectMatch,
  assertStringIncludes,
} from "std/assert/mod.ts";
import { assertSpyCall, resolvesNext, stub } from "std/testing/mock.ts";
import Stripe from "stripe";
import options from "./fresh.config.ts";

/**
 * @see {@link https://fresh.deno.dev/docs/examples/writing-tests|Writing tests} example on how to write tests for Fresh projects.
 */
const handler = await createHandler(manifest, options);

function assertResponseNotFound(resp: Response) {
  assertFalse(resp.ok);
  assertEquals(resp.status, Status.NotFound);
}

function assertResponseJson(resp: Response) {
  assert(resp.ok);
  assertNotEquals(resp.body, null);
  assertEquals(resp.headers.get("content-type"), "application/json");
}

Deno.test("[e2e] GET /", async () => {
  const resp = await handler(new Request("http://localhost"));

  assert(resp.ok);
  assertInstanceOf(resp.body, ReadableStream);
  assertEquals(
    resp.headers.get("content-type"),
    "text/html; charset=utf-8",
  );
  assertEquals(resp.status, 200);
});

Deno.test("[e2e] GET /callback", async () => {
  const resp = await handler(
    new Request("http://localhost/callback"),
  );

  assertFalse(resp.ok);
  assertInstanceOf(resp.body, ReadableStream);
  assertEquals(
    resp.headers.get("content-type"),
    "text/html; charset=utf-8",
  );
  assertEquals(resp.status, 500);
});

Deno.test("[e2e] GET /blog", async () => {
  const resp = await handler(
    new Request("http://localhost/blog"),
  );

  assert(resp.ok);
  assertInstanceOf(resp.body, ReadableStream);
  assertEquals(
    resp.headers.get("content-type"),
    "text/html; charset=utf-8",
  );
  assertEquals(resp.status, 200);
});

Deno.test("[e2e] GET /pricing", async () => {
  const req = new Request("http://localhost/pricing");

  Deno.env.delete("STRIPE_SECRET_KEY");
  const resp = await handler(req);

  assertFalse(resp.ok);
  assertEquals(typeof await resp.text(), "string");
  assertEquals(
    resp.headers.get("content-type"),
    "text/html; charset=utf-8",
  );
  assertEquals(resp.status, 404);
});

Deno.test("[e2e] GET /signin", async () => {
  const resp = await handler(
    new Request("http://localhost/signin"),
  );

  assertFalse(resp.ok);
  assertFalse(resp.body);
  assertStringIncludes(
    resp.headers.get("location")!,
    "https://github.com/login/oauth/authorize",
  );
  assertEquals(resp.status, 302);
});

Deno.test("[e2e] GET /signout", async () => {
  const resp = await handler(
    new Request("http://localhost/signout"),
  );

  assertFalse(resp.ok);
  assertFalse(resp.body);
  assertEquals(resp.headers.get("location"), "/");
  assertEquals(resp.status, 302);
});

Deno.test("[e2e] GET /dashboard", async (test) => {
  const url = "http://localhost/dashboard";
  const user = genNewUser();
  await createUser(user);

  await test.step("returns redirect response if the session user is not signed in", async () => {
    const resp = await handler(new Request(url));

    assertFalse(resp.ok);
    assertEquals(resp.body, null);
    assertEquals(resp.headers.get("location"), "/signin");
    assertEquals(resp.status, Status.SeeOther);
  });

  await test.step("returns redirect response to /dashboard/stats from root route when the session user is signed in", async () => {
    const resp = await handler(
      new Request(url, {
        headers: { cookie: "site-session=" + user.sessionId },
      }),
    );

    assertFalse(resp.ok);
    assertEquals(resp.body, null);
    assertEquals(resp.headers.get("location"), "/dashboard/stats");
    assertEquals(resp.status, Status.SeeOther);
  });
});

Deno.test("[e2e] GET /dashboard/stats", async (test) => {
  const url = "http://localhost/dashboard/stats";
  const user = genNewUser();
  await createUser(user);

  await test.step("returns redirect response if the session user is not signed in", async () => {
    const resp = await handler(new Request(url));
    assertFalse(resp.ok);
    assertEquals(resp.body, null);
    assertEquals(resp.headers.get("location"), "/signin");
    assertEquals(resp.status, Status.SeeOther);
  });

  await test.step("renders dashboard stats chart for a user who is signed in", async () => {
    const resp = await handler(
      new Request(url, {
        headers: { cookie: "site-session=" + user.sessionId },
      }),
    );
    assertStringIncludes(await resp.text(), "<!--frsh-chart_default");
  });
});

Deno.test("[e2e] GET /dashboard/users", async (test) => {
  const url = "http://localhost/dashboard/users";
  const user = genNewUser();
  await createUser(user);

  await test.step("returns redirect response if the session user is not signed in", async () => {
    const resp = await handler(new Request(url));
    assertFalse(resp.ok);
    assertEquals(resp.body, null);
    assertEquals(resp.headers.get("location"), "/signin");
    assertEquals(resp.status, Status.SeeOther);
  });

  await test.step("renders dashboard stats table for a user who is signed in", async () => {
    const resp = await handler(
      new Request(url, {
        headers: { cookie: "site-session=" + user.sessionId },
      }),
    );
    assertStringIncludes(await resp.text(), "<!--frsh-userstable_default");
  });
});

Deno.test("[e2e] GET /submit", async () => {
  const resp = await handler(
    new Request("http://localhost/submit"),
  );

  assertFalse(resp.ok);
  assertFalse(resp.body);
  assertEquals(resp.headers.get("location"), "/signin");
  assertEquals(resp.status, 303);
});

Deno.test("[e2e] GET /feed", async () => {
  const resp = await handler(
    new Request("http://localhost/feed"),
  );

  assert(resp.ok);
  assertInstanceOf(resp.body, ReadableStream);
  assertEquals(
    resp.headers.get("content-type"),
    "application/atom+xml; charset=utf-8",
  );
  assertEquals(resp.status, 200);
});

Deno.test("[e2e] GET /api/items", async () => {
  const item1 = genNewItem();
  const item2 = genNewItem();
  await createItem(item1);
  await createItem(item2);

  const req = new Request("http://localhost/api/items");
  const resp = await handler(req);

  const { values } = await resp.json();
  assertResponseJson(resp);
  assertArrayIncludes(values, [
    JSON.parse(JSON.stringify(item1)),
    JSON.parse(JSON.stringify(item2)),
  ]);
});

Deno.test("[e2e] GET /api/items/[id]", async () => {
  const item = genNewItem();
  const req = new Request("http://localhost/api/items/" + item.id);

  const resp1 = await handler(req);
  assertFalse(resp1.ok);
  assertEquals(await resp1.text(), "Item not found");
  assertEquals(resp1.status, Status.NotFound);

  await createItem(item);
  const resp2 = await handler(req);
  assertResponseJson(resp2);
  assertEquals(await resp2.json(), JSON.parse(JSON.stringify(item)));
});

Deno.test("[e2e] GET /api/items/[id]/comments", async () => {
  const item = genNewItem();
  const comment: Comment = {
    ...genNewComment(),
    itemId: item.id,
  };
  const req = new Request(`http://localhost/api/items/${item.id}/comments`);

  const resp1 = await handler(req);
  assertFalse(resp1.ok);
  assertEquals(await resp1.text(), "Item not found");
  assertEquals(resp1.status, Status.NotFound);

  await createItem(item);
  await createComment(comment);
  const resp2 = await handler(req);
  const { values } = await resp2.json();
  assertResponseJson(resp2);
  assertEquals(values, [JSON.parse(JSON.stringify(comment))]);
});

Deno.test("[e2e] POST /api/items", async () => {
  const resp = await handler(
    new Request("http://localhost/api/items", { method: "POST" }),
  );

  assertFalse(resp.ok);
  assertEquals(await resp.text(), "User must be signed in");
  assertEquals(resp.status, Status.Unauthorized);
});

Deno.test("[e2e] GET /api/users", async () => {
  const user1 = genNewUser();
  const user2 = genNewUser();
  await createUser(user1);
  await createUser(user2);

  const req = new Request("http://localhost/api/users");
  const resp = await handler(req);

  const { values } = await resp.json();
  assertResponseJson(resp);
  assertArrayIncludes(values, [user1, user2]);
});

Deno.test("[e2e] GET /api/users/[login]", async () => {
  const user = genNewUser();
  const req = new Request("http://localhost/api/users/" + user.login);

  const resp1 = await handler(req);
  assertFalse(resp1.ok);
  assertEquals(await resp1.text(), "User not found");
  assertEquals(resp1.status, Status.NotFound);

  await createUser(user);
  const resp2 = await handler(req);
  assertResponseJson(resp2);
  assertEquals(await resp2.json(), user);
});

Deno.test("[e2e] GET /api/users/[login]/items", async () => {
  const user = genNewUser();
  const item: Item = {
    ...genNewItem(),
    userLogin: user.login,
  };
  const req = new Request(`http://localhost/api/users/${user.login}/items`);

  const resp1 = await handler(req);
  assertResponseNotFound(resp1);

  await createUser(user);
  await createItem(item);

  const resp2 = await handler(req);
  const { values } = await resp2.json();
  assertResponseJson(resp2);
  assertArrayIncludes(values, [JSON.parse(JSON.stringify(item))]);
});

Deno.test("[e2e] GET /api/users/[login]/notifications", async () => {
  const user = genNewUser();
  const notification: Notification = {
    ...genNewNotification(),
    userLogin: user.login,
  };
  const url = "http://localhost/api/me/notifications";

  const resp1 = await handler(new Request(url));
  assertFalse(resp1.ok);
  assertEquals(resp1.status, Status.Unauthorized);

  await createUser(user);
  await createNotification(notification);

  const resp2 = await handler(
    new Request(url, {
      headers: { cookie: "site-session=" + user.sessionId },
    }),
  );
  const { values } = await resp2.json();
  assertResponseJson(resp2);
  assertArrayIncludes(values, [
    JSON.parse(JSON.stringify(notification)),
  ]);
});

Deno.test("[e2e] POST /api/stripe-webhooks", async (test) => {
  const url = "http://localhost/api/stripe-webhooks";

  await test.step("returns HTTP 404 Not Found response if Stripe is disabled", async () => {
    Deno.env.delete("STRIPE_SECRET_KEY");
    const resp = await handler(new Request(url, { method: "POST" }));

    assertFalse(resp.ok);
    assertEquals(await resp.text(), "Not Found");
    assertEquals(resp.status, Status.NotFound);
  });

  await test.step("returns HTTP 400 Bad Request response if `Stripe-Signature` header is missing", async () => {
    Deno.env.set("STRIPE_SECRET_KEY", crypto.randomUUID());
    const resp = await handler(new Request(url, { method: "POST" }));

    assertFalse(resp.ok);
    assertEquals(await resp.text(), "`Stripe-Signature` header is missing");
    assertEquals(resp.status, Status.BadRequest);
  });

  await test.step("returns HTTP 500 Internal Server Error response if `STRIPE_WEBHOOK_SECRET` environment variable is not set", async () => {
    Deno.env.delete("STRIPE_WEBHOOK_SECRET");
    const resp = await handler(
      new Request(url, {
        method: "POST",
        headers: { "Stripe-Signature": crypto.randomUUID() },
      }),
    );

    assertFalse(resp.ok);
    assertEquals(
      await resp.text(),
      "`STRIPE_WEBHOOK_SECRET` environment variable is not set",
    );
    assertEquals(resp.status, Status.InternalServerError);
  });

  await test.step("returns HTTP 400 Bad Request response if the event payload is invalid", async () => {
    Deno.env.set("STRIPE_WEBHOOK_SECRET", crypto.randomUUID());
    const resp = await handler(
      new Request(url, {
        method: "POST",
        headers: { "Stripe-Signature": crypto.randomUUID() },
      }),
    );

    assertFalse(resp.ok);
    assertEquals(
      await resp.text(),
      "No webhook payload was provided.",
    );
    assertEquals(resp.status, Status.BadRequest);
  });
});

Deno.test("[e2e] GET /notifications/[id]", async (test) => {
  const notificationNotFoundUrl = "http://localhost/notifications/1";

  await test.step("returns redirect response if the session user is not signed in", async () => {
    const resp = await handler(new Request(notificationNotFoundUrl));
    assertFalse(resp.ok);
    assertEquals(resp.body, null);
    assertEquals(resp.headers.get("location"), "/signin");
    assertEquals(resp.status, Status.SeeOther);
  });

  const user = genNewUser();
  await createUser(user);

  await test.step("returns HTTP 404 Not Found response if the notification does not exist", async () => {
    const resp = await handler(
      new Request(notificationNotFoundUrl, {
        headers: { cookie: "site-session=" + user.sessionId },
      }),
    );

    assertFalse(resp.ok);
    assertResponseNotFound(resp);
  });

  const notification: Notification = {
    ...genNewNotification(),
    userLogin: user.login,
  };
  await createNotification(notification);
  const url = `http://localhost/notifications/${notification.id}`;

  await test.step("returns HTTP 500 Internal Server Error response if the db throws an error while deleting notification key", async () => {
    const kvAtomicStub = stub(
      kv,
      "atomic",
      () => {
        throw new Error(
          "Stubbed error thrown when KV attempts to delete notification",
        );
      },
    );
    const resp = await handler(
      new Request(url, {
        headers: { cookie: "site-session=" + user.sessionId },
      }),
    );

    assertEquals(resp.status, Status.InternalServerError);
    kvAtomicStub.restore();
  });

  await test.step("returns redirect response to the notification that was found", async () => {
    const resp = await handler(
      new Request(url, {
        headers: { cookie: "site-session=" + user.sessionId },
      }),
    );
    assertEquals(resp.headers.get("location"), notification.originUrl);
    assertEquals(resp.status, Status.SeeOther);
  });

  await test.step("returns HTTP 404 Not Found response after the notification was visited and the key was deleted", async () => {
    const resp = await handler(
      new Request(url, {
        headers: { cookie: "site-session=" + user.sessionId },
      }),
    );

    assertFalse(resp.ok);
    assertResponseNotFound(resp);
  });
});

Deno.test("[e2e] GET /items/[id]", async (test) => {
  await test.step("returns HTTP 404 Not Found response if the item does not exist", async () => {
    const resp = await handler(new Request("http://localhost/items/1"));

    assertFalse(resp.ok);
    assertResponseNotFound(resp);
  });

  const user = genNewUser();
  await createUser(user);
  const item: Item = {
    ...genNewItem(),
    userLogin: user.login,
  };
  await createItem(item);
  const url = `http://localhost/items/${item.id}`;

  await test.step("renders the item page with commenting enabled for signed in user", async () => {
    const resp = await handler(
      new Request(url, {
        headers: { cookie: "site-session=" + user.sessionId },
      }),
    );

    assertFalse((await resp.text()).includes("Sign in to comment"));
  });

  await test.step("renders the item page directing an anonymous user to sign in to comment", async () => {
    const resp = await handler(new Request(url));
    assertStringIncludes(await resp.text(), "Sign in to comment");
  });
});

Deno.test("[e2e] GET /account", async (test) => {
  const url = "http://localhost/account";

  await test.step("returns redirect response if the session user is not signed in", async () => {
    const resp = await handler(new Request(url));
    assertFalse(resp.ok);
    assertEquals(resp.body, null);
    assertEquals(resp.headers.get("location"), "/signin");
    assertEquals(resp.status, Status.SeeOther);
  });

  await test.step("renders the account page as a free user", async () => {
    const user = genNewUser();
    await createUser(user);

    const resp = await handler(
      new Request(url, {
        headers: { cookie: "site-session=" + user.sessionId },
      }),
    );

    assertStringIncludes(await resp.text(), 'href="/account/upgrade"');
  });

  await test.step("renders the account page as a premium user", async () => {
    const user = genNewUser();
    await createUser({ ...user, isSubscribed: true });

    const resp = await handler(
      new Request(url, {
        headers: { cookie: "site-session=" + user.sessionId },
      }),
    );

    assertStringIncludes(await resp.text(), 'href="/account/manage"');
  });
});

Deno.test("[e2e] GET /account/manage", async (test) => {
  const url = "http://localhost/account/manage";
  Deno.env.set("STRIPE_SECRET_KEY", crypto.randomUUID());

  await test.step("returns redirect response if the session user is not signed in", async () => {
    const resp = await handler(new Request(url));
    assertFalse(resp.ok);
    assertFalse(resp.body);
    assertEquals(resp.headers.get("location"), "/signin");
    assertEquals(resp.status, 303);
  });

  await test.step("returns HTTP 404 Not Found response if the session user does not have a Stripe customer ID", async () => {
    const user = genNewUser();
    await createUser({ ...user, stripeCustomerId: undefined });
    const resp = await handler(
      new Request(url, {
        headers: { cookie: "site-session=" + user.sessionId },
      }),
    );

    assertFalse(resp.ok);
    assertEquals(resp.status, Status.NotFound);
  });

  await test.step("returns redirect response to the URL returned by Stripe after creating a billing portal session", async () => {
    const user = genNewUser();
    await createUser(user);

    const session = { url: "https://stubbing-returned-url" } as Stripe.Response<
      Stripe.BillingPortal.Session
    >;
    const sessionsCreateStub = stub(
      stripe.billingPortal.sessions,
      "create",
      resolvesNext([session]),
    );

    const resp = await handler(
      new Request(url, {
        headers: { cookie: "site-session=" + user.sessionId },
      }),
    );

    assertFalse(resp.ok);
    assertEquals(resp.status, Status.SeeOther);
    assertSpyCall(sessionsCreateStub, 0, {
      args: [{
        customer: user.stripeCustomerId!,
        return_url: "http://localhost/account",
      }],
    });
    sessionsCreateStub.restore();
  });
});

Deno.test("[e2e] GET /account/upgrade", async (test) => {
  const url = "http://localhost/account/upgrade";

  await test.step("returns redirect response if the session user is not signed in", async () => {
    const resp = await handler(new Request(url));
    assertFalse(resp.ok);
    assertFalse(resp.body);
    assertEquals(resp.headers.get("location"), "/signin");
    assertEquals(resp.status, 303);
  });

  const user = genNewUser();
  await createUser(user);

  await test.step("returns HTTP 500 Internal Server Error response if the `STRIPE_PREMIUM_PLAN_PRICE_ID` environment variable is not set", async () => {
    Deno.env.set("STRIPE_SECRET_KEY", crypto.randomUUID());
    Deno.env.delete("STRIPE_PREMIUM_PLAN_PRICE_ID");
    const resp = await handler(
      new Request(url, {
        headers: { cookie: "site-session=" + user.sessionId },
      }),
    );

    assertFalse(resp.ok);
    assertEquals(resp.status, Status.InternalServerError);
  });

  await test.step("returns HTTP 404 Not Found response if Stripe is disabled", async () => {
    Deno.env.set("STRIPE_PREMIUM_PLAN_PRICE_ID", crypto.randomUUID());
    Deno.env.delete("STRIPE_SECRET_KEY");
    const resp = await handler(
      new Request(url, {
        headers: { cookie: "site-session=" + user.sessionId },
      }),
    );

    assertFalse(resp.ok);
    assertEquals(resp.status, Status.NotFound);
  });

  await test.step("returns HTTP 404 Not Found response if Stripe returns a `null` URL", async () => {
    Deno.env.set("STRIPE_PREMIUM_PLAN_PRICE_ID", crypto.randomUUID());
    Deno.env.set("STRIPE_SECRET_KEY", crypto.randomUUID());

    const session = { url: null } as Stripe.Response<
      Stripe.Checkout.Session
    >;
    const sessionsCreateStub = stub(
      stripe.checkout.sessions,
      "create",
      resolvesNext([session]),
    );

    const resp = await handler(
      new Request(url, {
        headers: { cookie: "site-session=" + user.sessionId },
      }),
    );

    assertFalse(resp.ok);
    assertEquals(resp.status, Status.NotFound);
    sessionsCreateStub.restore();
  });

  await test.step("returns redirect response to the URL returned by Stripe after creating a checkout session", async () => {
    const priceId = crypto.randomUUID();
    Deno.env.set("STRIPE_PREMIUM_PLAN_PRICE_ID", priceId);
    Deno.env.set("STRIPE_SECRET_KEY", crypto.randomUUID());

    const session = { url: "https://stubbing-returned-url" } as Stripe.Response<
      Stripe.Checkout.Session
    >;
    const sessionsCreateStub = stub(
      stripe.checkout.sessions,
      "create",
      resolvesNext([session]),
    );

    const resp = await handler(
      new Request(url, {
        headers: { cookie: "site-session=" + user.sessionId },
      }),
    );

    assertFalse(resp.ok);
    assertEquals(resp.status, Status.SeeOther);
    assertSpyCall(sessionsCreateStub, 0, {
      args: [{
        customer: user.stripeCustomerId!,
        success_url: "http://localhost/account",
        mode: "subscription",
        line_items: [
          {
            price: priceId,
            quantity: 1,
          },
        ],
      }],
    });
    sessionsCreateStub.restore();
  });
});

Deno.test("[e2e] POST /api/comments", async (test) => {
  const url = "http://localhost/api/comments";
  const user = genNewUser();
  await createUser(user);

  await test.step("returns HTTP 401 Unauthorized response if the session user is not signed in", async () => {
    const resp = await handler(
      new Request(url, { method: "POST" }),
    );
    assertFalse(resp.ok);
    assertEquals(resp.status, Status.Unauthorized);
  });

  await test.step("returns HTTP 400 Bad Request response if comment is missing text", async () => {
    const body = new FormData();
    const resp = await handler(
      new Request(url, {
        method: "POST",
        headers: { cookie: "site-session=" + user.sessionId },
        body,
      }),
    );

    assertEquals(await resp.text(), "Text must be a string");
    assertEquals(resp.status, Status.BadRequest);
  });

  await test.step("returns HTTP 400 Bad Request response if comment is missing item_id", async () => {
    const body = new FormData();
    body.set("text", "Comment text");
    const resp = await handler(
      new Request(url, {
        method: "POST",
        headers: { cookie: "site-session=" + user.sessionId },
        body,
      }),
    );

    assertEquals(await resp.text(), "Item ID must be a string");
    assertEquals(resp.status, Status.BadRequest);
  });

  await test.step("returns HTTP 404 Not Found response if the item is not found", async () => {
    const body = new FormData();
    body.set("text", "Comment text");
    body.set("item_id", "not-found-item-id");
    const resp = await handler(
      new Request(url, {
        method: "POST",
        headers: { cookie: "site-session=" + user.sessionId },
        body,
      }),
    );

    assertEquals(await resp.text(), "Item not found");
    assertEquals(resp.status, Status.NotFound);
  });

  await test.step("creates a comment but not a new notification if for one's own item", async () => {
    const item = { ...genNewItem(), userLogin: user.login };
    const comment = { text: "Comment text", itemId: item.id };
    await createItem(item);
    const body = new FormData();
    body.set("text", comment.text);
    body.set("item_id", comment.itemId);
    const resp = await handler(
      new Request(url, {
        method: "POST",
        headers: { cookie: "site-session=" + user.sessionId },
        body,
      }),
    );
    const comments = await collectValues(listCommentsByItem(item.id));

    assertEquals(resp.status, Status.SeeOther);
    assertEquals(await ifUserHasNotifications(user.login), false);
    // Deep partial match since the comment ID is a ULID generated at runtime
    assertObjectMatch(comments[0], comment);
  });

  await test.step("creates a comment and notification if for someone elses item", async () => {
    const item = genNewItem();
    const comment = { text: "Comment text", itemId: item.id };
    await createItem(item);
    const body = new FormData();
    body.set("text", comment.text);
    body.set("item_id", comment.itemId);
    const resp = await handler(
      new Request(url, {
        method: "POST",
        headers: { cookie: "site-session=" + user.sessionId },
        body,
      }),
    );
    const comments = await collectValues(listCommentsByItem(item.id));

    assertEquals(resp.status, Status.SeeOther);
    assertEquals(await ifUserHasNotifications(item.userLogin), true);
    assertEquals(await ifUserHasNotifications(user.login), false);
    // Deep partial match since the comment ID is a ULID generated at runtime
    assertObjectMatch(comments[0], comment);
  });
});

Deno.test("[e2e] GET /api/me/votes", async () => {
  const user = genNewUser();
  await createUser(user);
  const item1 = genNewItem();
  const item2 = genNewItem();
  await createItem(item1);
  await createItem(item2);
  await createVote({
    userLogin: user.login,
    itemId: item1.id,
    createdAt: new Date(),
  });
  await createVote({
    userLogin: user.login,
    itemId: item2.id,
    createdAt: new Date(),
  });
  const resp = await handler(
    new Request("http://localhost/api/me/votes", {
      headers: { cookie: "site-session=" + user.sessionId },
    }),
  );
  const body = await resp.json();
  assertArrayIncludes(body, [{ ...item1, score: 1 }, { ...item2, score: 1 }]);
});
