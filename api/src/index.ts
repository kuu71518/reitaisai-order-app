import { Hono } from "hono";
import { cors } from "hono/cors";
import webpush from "web-push";


type Bindings = {
  DB: D1Database;
  VAPID_SUBJECT?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use("/api/*", cors());

function configureWebPush(env: Bindings) {
  const { VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = env;

  if (!VAPID_SUBJECT || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return false;
  }

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  return true;
}

// 1. ログインAPI
app.post("/api/auth/login", async (c) => {
  try {
    const body = await c.req.json();
    const { group_id, discord_id } = body;
    if (!group_id || !discord_id || typeof discord_id !== "string" || discord_id.length > 50) {
      return c.json({ success: false, message: "不正な入力形式です" }, 400);
    }
    const cleanDiscordId = discord_id.trim();
    const user = await c.env.DB.prepare(
      "SELECT id, name, group_id, role, discord_id FROM users WHERE group_id = ? AND discord_id = ?"
    ).bind(group_id, cleanDiscordId).first();

    if (!user) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return c.json({ success: false, message: "グループが違うか、Discord IDが登録されています" }, 401);
    }

    await c.env.DB.prepare("INSERT INTO audit_logs (action_type, details) VALUES (?, ?)")
      .bind("LOGIN", `[${user.role}] ${user.name} (${user.group_id}) がログインしました (Discord ID: ${cleanDiscordId})`)
      .run();
    return c.json({ success: true, user });
  } catch (e) {
    return c.json({ success: false, message: "サーバーエラー" }, 500);
  }
});

// 2. メニュー取得API
app.get("/api/menu", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM menu_items WHERE is_active = 1").all();
  return c.json({ success: true, data: results });
});

// 3. 注文一覧取得API
app.get("/api/orders", async (c) => {
  const status = c.req.query("status");
  const group_id = c.req.query("group_id");
  let sql = `SELECT o.id, o.quantity, o.status, u.name as user_name, m.name as menu_name, m.size FROM orders o JOIN users u ON o.user_id = u.id JOIN menu_items m ON o.menu_item_id = m.id WHERE 1=1`;
  const params: any[] = [];
  if (status) { sql += ` AND o.status = ?`; params.push(status); }
  if (group_id) { sql += ` AND u.group_id = ?`; params.push(group_id); }
  const { results } = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json({ success: true, data: results });
});

// 4. 新規注文API
app.post("/api/orders", async (c) => {
  try {
    const body = await c.req.json();
    const quantity = body.quantity || 1;
    await c.env.DB.prepare("INSERT INTO orders (user_id, menu_item_id, quantity, status) VALUES (?, ?, ?, ?)")
      .bind(body.user_id, body.menu_item_id, quantity, "pending").run();

    const user = await c.env.DB.prepare("SELECT name, group_id FROM users WHERE id = ?").bind(body.user_id).first();
    const menu = await c.env.DB.prepare("SELECT name, size FROM menu_items WHERE id = ?").bind(body.menu_item_id).first();

    if (user && menu) {
      const { results: subs } = await c.env.DB.prepare("SELECT * FROM push_subscriptions WHERE group_id = ?").bind(user.group_id).all();
      if (subs && subs.length > 0 && configureWebPush(c.env)) {
        const payload = JSON.stringify({
          title: "🆕 新着オーダー",
          body: `${user.name} さん: ${menu.name} (${menu.size}) × ${quantity}`,
        });
        for (const sub of subs) {
          try {
            await webpush.sendNotification({
              endpoint: sub.endpoint as string,
              keys: { p256dh: sub.p256dh as string, auth: sub.auth as string },
            }, payload);
          } catch (pushErr) {
            await c.env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?").bind(sub.id).run();
          }
        }
      }
    }
    return c.json({ success: true });
  } catch (e) {
    return c.json({ success: false, message: "注文エラー" }, 500);
  }
});

// 5. ステータス更新API
app.patch("/api/orders/status", async (c) => {
  const body = await c.req.json();
  const placeholders = body.order_ids.map(() => "?").join(",");
  await c.env.DB.prepare(`UPDATE orders SET status = ?, manager_memo = ? WHERE id IN (${placeholders})`)
    .bind(body.status, body.manager_memo || null, ...body.order_ids).run();
  return c.json({ success: true });
});

// 6. 会計サマリーAPI
app.get("/api/orders/summary", async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT u.name, SUM(m.price * o.quantity) as total_price FROM orders o JOIN users u ON o.user_id = u.id JOIN menu_items m ON o.menu_item_id = m.id GROUP BY u.name`
    ).all();
    return c.json({ success: true, data: results });
  } catch (e) { return c.json({ success: false }, 500); }
});

// 7. システムリセットAPI
app.post("/api/orders/reset", async (c) => {
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM orders"),
      c.env.DB.prepare("DELETE FROM cancelled_orders"),
      c.env.DB.prepare("DELETE FROM push_subscriptions"),
      c.env.DB.prepare("DELETE FROM users WHERE is_manual_added = 1"),
    ]);
    await c.env.DB.prepare("INSERT INTO audit_logs (action_type, details) VALUES (?, ?)")
      .bind("SYSTEM_RESET", "全データの初期化と、当日追加メンバーの削除を実行").run();
    return c.json({ success: true });
  } catch (e) { return c.json({ success: false }, 500); }
});

// 8. ユーザー追加API
app.post("/api/users", async (c) => {
  try {
    const body = await c.req.json();
    const { name, group_id, role, discord_id } = body;
    if (!name || !group_id || !role || !discord_id) return c.json({ success: false }, 400);
    const cleanDiscordId = discord_id.trim();
    const existing = await c.env.DB.prepare("SELECT id FROM users WHERE discord_id = ?").bind(cleanDiscordId).first();
    if (existing) return c.json({ success: false, message: "そのDiscord IDは既に登録されています" }, 400);
    await c.env.DB.prepare("INSERT INTO users (name, group_id, role, discord_id, is_manual_added) VALUES (?, ?, ?, ?, 1)")
      .bind(name, group_id, role, cleanDiscordId).run();
    return c.json({ success: true });
  } catch (e) { return c.json({ success: false }, 500); }
});

// 9. 個人の注文履歴を取得
app.get("/api/users/:id/orders", async (c) => {
  const userId = c.req.param("id");
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT o.id, m.name as item_name, m.size, m.price, o.quantity, o.status, o.created_at FROM orders o JOIN menu_items m ON o.menu_item_id = m.id WHERE o.user_id = ? ORDER BY o.created_at DESC`
    ).bind(userId).all();
    return c.json({ success: true, data: results });
  } catch (e) { return c.json({ success: false }, 500); }
});

// 10. 注文個数の変更
app.patch("/api/orders/:id/quantity", async (c) => {
  const id = c.req.param("id");
  try {
    const body = await c.req.json();
    await c.env.DB.prepare("UPDATE orders SET quantity = ? WHERE id = ?").bind(body.quantity, id).run();
    return c.json({ success: true });
  } catch (e) { return c.json({ success: false }, 500); }
});

// 11. プッシュ通知の購読
app.post("/api/notifications/subscribe", async (c) => {
  try {
    const body = await c.req.json();
    const { group_id, subscription } = body;
    const existing = await c.env.DB.prepare("SELECT id FROM push_subscriptions WHERE endpoint = ?").bind(subscription.endpoint).first();
    if (!existing) {
      await c.env.DB.prepare("INSERT INTO push_subscriptions (group_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)")
        .bind(group_id, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth).run();
    }
    return c.json({ success: true });
  } catch (e) { return c.json({ success: false }, 500); }
});

// ==========================================
// 🛡️ 管理者用API (/api/admin/...)
// ==========================================

// 12. 管理用：注文一覧の取得
app.get("/api/admin/orders", async (c) => {
  try {
    const { results } = await c.env.DB.prepare(`SELECT o.id, u.name as user_name, m.name as item_name, m.size, m.price, o.quantity, o.created_at, u.group_id FROM orders o JOIN users u ON o.user_id = u.id JOIN menu_items m ON o.menu_item_id = m.id ORDER BY o.created_at DESC`).all();
    return c.json({ success: true, data: results });
  } catch (e) { return c.json({ success: false }, 500); }
});

// 14. 管理用：ダッシュボード統計情報
app.get("/api/admin/stats", async (c) => {
  try {
    const users = await c.env.DB.prepare("SELECT COUNT(*) as count FROM users").first();
    const orders = await c.env.DB.prepare("SELECT COUNT(*) as count FROM orders").first();
    const cancels = await c.env.DB.prepare("SELECT COUNT(*) as count FROM cancelled_orders").first();
    const sales = await c.env.DB.prepare(`SELECT SUM(m.price * o.quantity) as total FROM orders o JOIN menu_items m ON o.menu_item_id = m.id`).first();
    return c.json({
      success: true,
      data: {
        total_users: users?.count || 0,
        total_orders: orders?.count || 0,
        total_cancels: cancels?.count || 0,
        total_sales: sales?.total || 0,
      },
    });
  } catch (e) { return c.json({ success: false }, 500); }
});

// 15. 管理用：監査ログのダウンロード
app.get("/api/admin/logs/export", async (c) => {
  try {
    const { results } = await c.env.DB.prepare("SELECT * FROM audit_logs ORDER BY created_at DESC").all();
    const header = "ID,アクション,詳細,日時\n";
    const rows = results.map((row: any) => `${row.id},${row.action_type},"${row.details}",${row.created_at}`).join("\n");
    return new Response("\uFEFF" + header + rows, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="audit_log.csv"',
      },
    });
  } catch (e) { return c.json({ success: false }, 500); }
});

// 16. 管理用：ユーザー個別削除
app.delete("/api/admin/users/:id", async (c) => {
  const id = c.req.param("id");
  try {
    await c.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
    return c.json({ success: true });
  } catch (e) { return c.json({ success: false }, 500); }
});

// 17. 修正：全ユーザーリスト取得（合計金額付き）
app.get("/api/admin/users", async (c) => {
  try {
    const { results } = await c.env.DB.prepare(`
      SELECT u.id, u.name, u.group_id, u.role, u.discord_id, u.is_manual_added, IFNULL(SUM(m.price * o.quantity), 0) as total_spent
      FROM users u
      LEFT JOIN orders o ON u.id = o.user_id AND o.status != 'cancelled'
      LEFT JOIN menu_items m ON o.menu_item_id = m.id
      GROUP BY u.id
      ORDER BY u.group_id, u.name
    `).all();
    return c.json({ success: true, data: results });
  } catch (e) { return c.json({ success: false }, 500); }
});

// 18. 管理用：削除履歴の取得
app.get("/api/cancelled-orders", async (c) => {
  try {
    const { results } = await c.env.DB.prepare("SELECT * FROM cancelled_orders ORDER BY cancelled_at DESC").all();
    return c.json({ success: true, data: results });
  } catch (e) { return c.json({ success: false }, 500); }
});

// 19. 監査ログを画面用に取得するAPI
app.get("/api/admin/logs", async (c) => {
  try {
    const { results } = await c.env.DB.prepare("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 200").all();
    return c.json({ success: true, data: results });
  } catch (e) { return c.json({ success: false }, 500); }
});

// 20. 管理用：メニュー一覧の取得（管理画面用）
app.get("/api/admin/menu", async (c) => {
  try {
    const { results } = await c.env.DB.prepare("SELECT * FROM menu_items ORDER BY category, name").all();
    return c.json({ success: true, data: results });
  } catch (e) { return c.json({ success: false }, 500); }
});

// 21. 管理用：メニューの新規追加
app.post("/api/admin/menu", async (c) => {
  try {
    const body = await c.req.json();
    await c.env.DB.prepare("INSERT INTO menu_items (name, category, price, size, is_active) VALUES (?, ?, ?, ?, 1)")
      .bind(body.name, body.category, body.price, body.size).run();
    await c.env.DB.prepare("INSERT INTO audit_logs (action_type, details) VALUES (?, ?)")
      .bind("MENU_ADD", `メニュー追加: ${body.name} (${body.size}) ¥${body.price}`).run();
    return c.json({ success: true });
  } catch (e) { return c.json({ success: false }, 500); }
});

// 22. 管理用：メニューの編集（価格などの更新）
app.patch("/api/admin/menu/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const body = await c.req.json();
    await c.env.DB.prepare("UPDATE menu_items SET name = ?, category = ?, price = ?, size = ? WHERE id = ?")
      .bind(body.name, body.category, body.price, body.size, id).run();
    await c.env.DB.prepare("INSERT INTO audit_logs (action_type, details) VALUES (?, ?)")
      .bind("MENU_UPDATE", `メニュー更新(ID:${id}): ${body.name} ¥${body.price}`).run();
    return c.json({ success: true });
  } catch (e) { return c.json({ success: false }, 500); }
});

// 🌟 23. 管理用：メニューの削除（ダブりを解消して1つにまとめました）
app.delete("/api/admin/menu/:id", async (c) => {
  const id = c.req.param("id");
  try {
    await c.env.DB.prepare("DELETE FROM menu_items WHERE id = ?").bind(id).run();
    await c.env.DB.prepare("INSERT INTO audit_logs (action_type, details) VALUES (?, ?)")
      .bind("MENU_DELETE", `メニュー削除実行 (ID:${id})`).run();
    return c.json({ success: true });
  } catch (e) {
    // 注文履歴があって削除できない場合の丁寧なエラーメッセージ
    return c.json({ success: false, message: "注文履歴があるメニューは削除できません。名前を変更して対応してください。" }, 500);
  }
});

// 24. マネージャー用：フリー項目（特別会計）の追加
app.post("/api/manager/custom-order", async (c) => {
  try {
    const body = await c.req.json();
    const { user_id, name, price } = body;
    if (!user_id || !name || price === undefined) return c.json({ success: false, message: "入力が不足しています" }, 400);

    const menuResult = await c.env.DB.prepare("INSERT INTO menu_items (category, name, size, price, is_active) VALUES (?, ?, ?, ?, 1)")
      .bind("特別会計", name, "ー", price).run();
    const newMenuId = menuResult.meta.last_row_id;

    await c.env.DB.prepare("INSERT INTO orders (user_id, menu_item_id, quantity, status) VALUES (?, ?, 1, 'ordered')")
      .bind(user_id, newMenuId).run();
    await c.env.DB.prepare("INSERT INTO audit_logs (action_type, details) VALUES (?, ?)")
      .bind("CUSTOM_ORDER", `特別会計追加: ${name} (¥${price}) をユーザーID:${user_id} に追加`).run();

    return c.json({ success: true });
  } catch (e) { return c.json({ success: false, message: "フリー項目の追加に失敗しました" }, 500); }
});

// ==========================================
// 🌟 25. 管理用：ユーザーの権限・グループの変更
// ==========================================
app.patch("/api/admin/users/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const body = await c.req.json();
    await c.env.DB.prepare("UPDATE users SET group_id = ?, role = ? WHERE id = ?")
      .bind(body.group_id, body.role, id).run();

    await c.env.DB.prepare("INSERT INTO audit_logs (action_type, details) VALUES (?, ?)")
      .bind("USER_UPDATE", `ユーザー情報更新(ID:${id}): グループ=${body.group_id}, 権限=${body.role}`).run();

    return c.json({ success: true });
  } catch (e) {
    return c.json({ success: false, message: "更新に失敗しました" }, 500);
  }
});

export default app;
