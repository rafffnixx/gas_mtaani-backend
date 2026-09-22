// 📁 backend/src/services/notificationTemplates.js
// Every event that produces a notification has a template here.
// A template is a pure function: (ctx) => { title, body, payload }.

const templates = {
  // ─────────────────────────────────────────
  // ORDER EVENTS
  // ─────────────────────────────────────────
  order_status_customer: {
    title: (c) => `Order #${c.order_number}`,
    body: (c) => {
      const map = {
        pending:           'We received your order.',
        searching:         'Looking for a partner near you…',
        assigned:          'A partner has been assigned.',
        accepted:          'Your partner accepted the order.',
        picked_up:         'Your order has been picked up.',
        out_for_delivery:  'Your order is on the way.',
        delivered:         'Delivered! Please confirm to complete.',
        confirmed:         'Order confirmed. Thank you!',
        cancelled:         'Order cancelled.',
        declined:          'The partner declined. Finding another…',
      };
      return map[c.status] || 'Order updated.';
    },
    payload: (c) => ({
      screen: 'OrderTracking',
      params: { orderId: c.order_id },
    }),
  },

  order_status_agent: {
    title: (c) => `Order #${c.order_number}`,
    body: (c) => {
      const map = {
        assigned:         'New order assigned to you. Tap to accept.',
        accepted:         'You accepted this order. Head to the pickup.',
        picked_up:        'You picked up the order.',
        out_for_delivery: 'You are out for delivery.',
        delivered:        'You marked the order delivered.',
        confirmed:        'Customer confirmed. Earnings added.',
        cancelled:        'Order cancelled by customer.',
        declined:         'You declined this order.',
      };
      return map[c.status] || 'Order updated.';
    },
    payload: (c) => ({
      screen: 'AgentOrderDetail',
      params: { orderId: c.order_id },
    }),
  },

  // ─────────────────────────────────────────
  // PAYMENT EVENTS
  // ─────────────────────────────────────────
  payment_received: {
    title: () => 'Payment confirmed',
    body: (c) =>
      `We received KES ${Number(c.amount || 0).toLocaleString()} for order #${c.order_number}.`,
    payload: (c) => ({
      screen: 'OrderTracking',
      params: { orderId: c.order_id },
    }),
  },

  payment_failed: {
    title: () => 'Payment failed',
    body: (c) =>
      `We couldn't process payment for order #${c.order_number}. Try again or pay cash.`,
    payload: (c) => ({
      screen: 'Payment',
      params: { orderId: c.order_id },
    }),
  },

  refund_issued: {
    title: () => 'Refund issued',
    body: (c) =>
      `KES ${Number(c.amount || 0).toLocaleString()} refund for order #${c.order_number} has been initiated.`,
    payload: (c) => ({
      screen: 'OrderTracking',
      params: { orderId: c.order_id },
    }),
  },

  // ─────────────────────────────────────────
  // CHAT EVENTS
  // ─────────────────────────────────────────
  chat_support_reply: {
    title: () => 'Gas Mtaani Support',
    body: (c) => c.preview || 'New message from support.',
    payload: (c) => ({
      screen: 'CustomerChat',
      params: { threadId: c.thread_id },
    }),
  },

  chat_order_reply: {
    title: (c) => `Order #${c.order_number}`,
    body: (c) => c.preview || 'New message about your order.',
    payload: (c) => ({
      screen: 'CustomerChat',
      params: { threadId: c.thread_id },
    }),
  },

  chat_customer_reply_agent: {
    title: () => 'Customer message',
    body: (c) => c.preview || 'New message from customer.',
    payload: (c) => ({
      screen: 'AgentChat',
      params: { threadId: c.thread_id },
    }),
  },

  // ─────────────────────────────────────────
  // SYSTEM
  // ─────────────────────────────────────────
  system_welcome: {
    title: () => 'Welcome to Gas Mtaani',
    body: (c) => `Hi ${c.name || 'there'}, order gas in seconds.`,
    payload: () => ({ screen: 'Home' }),
  },

  system_agent_approved: {
    title: () => "You're approved!",
    body: () =>
      'Your agent account is live. Toggle online to receive orders.',
    payload: () => ({ screen: 'Dashboard' }),
  },
};

/**
 * Render a template.
 * @param {string} key   template key
 * @param {object} ctx   context object passed to the template
 * @returns {{ title, body, payload }}
 */
function render(key, ctx = {}) {
  const tpl = templates[key];
  if (!tpl) {
    return {
      title: 'Notification',
      body: 'Something happened.',
      payload: {},
    };
  }
  return {
    title:   tpl.title(ctx),
    body:    tpl.body(ctx),
    payload: tpl.payload(ctx),
  };
}

module.exports = { templates, render };