const { test, expect } = require('playwright/test');

// Two deliberately seeded changes make the same suite useful as a comparison.
const baseline = process.env.DEMO_BASELINE === '1';

function checkoutRoute(customer) {
  const signedIn = baseline ? customer.session.active : customer.active;
  return Response.redirect(new URL(signedIn ? '/payment' : '/sign-in', 'https://shop.example'));
}

function receiptTotal(receipt) {
  return baseline ? receipt.subtotal + receipt.shipping : receipt.subtotal;
}

test('checkout sends signed-in customers to payment', () => {
  const response = checkoutRoute({ session: { active: true } });
  const destination = new URL(response.headers.get('Location'));
  expect(destination.pathname).toBe('/payment');
});

test('receipt total includes shipping', () => {
  const receipt = { subtotal: 25, shipping: 5 };
  expect(receiptTotal(receipt)).toBe(30);
});

test('checkout service recovers on retry', async ({}, testInfo) => {
  expect(testInfo.retry).toBe(1);
});

test('cart tracks item quantities', () => {
  expect([1, 2]).toHaveLength(2);
});
