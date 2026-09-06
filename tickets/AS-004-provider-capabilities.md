# AS-004: Establish pooling and continuation support for each harness

**Status:** Proposed goal

## Why this matters

Native harnesses may differ in how authenticated capacity can be selected or changed. The product model should remain clear while actual support is established for each provider.

## Goal

Determine and document how each supported harness can participate in subscription pooling and preserve sessions across changes in supplying capacity.

## Desired outcomes

- The supported account-selection, concurrent-execution, capacity-reporting, and continuation behaviors are explicit per harness.
- Verified capabilities are distinguished from proposed or unsupported behaviors.
- Pooling retains the native harness capabilities on which existing consumers depend.
- Support for changing subscriptions within a provider is distinguished from any separate capability to move work between providers.
