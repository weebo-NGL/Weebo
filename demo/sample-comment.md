## TraceBrief · Playwright

**2 unexpected failures.**

1 test recovered on retry.

<h3>checkout sends signed-in customers to payment (checkout-api)</h3>

<p><code>checkout.spec.cjs:15</code></p>

<p>Passed in the supplied baseline report.</p>

<pre>Error: expect(received).toBe(expected) // Object.is equality
Expected: &quot;/payment&quot;
Received: &quot;/sign-in&quot;</pre>

<p><strong>Next check</strong> · Check whether a redirect or session fixture sent the test to /sign-in while it was waiting for /payment.</p>

<h3>receipt total includes shipping (checkout-api)</h3>

<p><code>checkout.spec.cjs:21</code></p>

<p>Passed in the supplied baseline report.</p>

<pre>Error: expect(received).toBe(expected) // Object.is equality
Expected: 30
Received: 25</pre>

<p><strong>Next check</strong> · Check the inputs at this assertion and trace how they produced 25, which is 5 below the expected 30.</p>
