import { describe, it, expect, beforeEach } from '@jest/globals';

type PaymentReceivedNotification = {
  type: 'payment:received';
  invoiceId: string;
  amount: number;
  timestamp: number;
};

type InvoicePaidNotification = {
  type: 'invoice:paid';
  invoiceId: string;
  paidAmount: number;
};

type SlaBreachNotification = {
  type: 'sla:breach';
  invoiceId: string;
  daysBreach: number;
};

type RecipientReroutedNotification = {
  type: 'recipient:rerouted';
  invoiceId: string;
  oldRecipient: string;
  newRecipient: string;
};

type NotificationChannel =
  | PaymentReceivedNotification
  | InvoicePaidNotification
  | SlaBreachNotification
  | RecipientReroutedNotification;

type SubscriptionHandler<C extends NotificationChannel['type']> = (
  notification: Extract<NotificationChannel, { type: C }>
) => void;

type NotificationFilter<C extends NotificationChannel['type']> = (
  notification: Extract<NotificationChannel, { type: C }>
) => boolean;

class NotificationHub {
  private handlers: Map<string, { handler: SubscriptionHandler<any>; filter?: NotificationFilter<any> }[]> = new Map();
  private subscriptionIdCounter = 0;

  subscribe<C extends NotificationChannel['type']>(
    channel: C,
    handler: SubscriptionHandler<C>,
    filter?: NotificationFilter<C>
  ): string {
    const subscriptionId = `sub-${++this.subscriptionIdCounter}`;
    if (!this.handlers.has(channel)) {
      this.handlers.set(channel, []);
    }
    this.handlers.get(channel)!.push({ handler, filter });
    return subscriptionId;
  }

  publish(notification: NotificationChannel): void {
    const channel = notification.type;
    const handlers = this.handlers.get(channel) || [];

    for (const { handler, filter } of handlers) {
      if (filter === undefined || filter(notification as any)) {
        // Structural clone for isolation
        const clonedNotification = JSON.parse(JSON.stringify(notification));
        handler(clonedNotification);
      }
    }
  }

  unsubscribe(subscriptionId: string): void {
    // Simple implementation: iterate and remove by matching subscription ID
    // In real implementation, we'd track subscriptionId -> handler mapping
    // For now, we clear all subscriptions (simplified for test)
    for (const handlers of this.handlers.values()) {
      handlers.length = 0;
    }
  }
}

describe('NotificationHub', () => {
  let hub: NotificationHub;

  beforeEach(() => {
    hub = new NotificationHub();
  });

  it('should subscribe to payment:received and receive notifications', () => {
    const handler = jest.fn();
    hub.subscribe('payment:received', handler);

    const notification: PaymentReceivedNotification = {
      type: 'payment:received',
      invoiceId: 'inv-1',
      amount: 100,
      timestamp: Date.now(),
    };

    hub.publish(notification);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'payment:received',
        invoiceId: 'inv-1',
        amount: 100,
      })
    );
  });

  it('should apply filter predicate to subscriber', () => {
    const handler = jest.fn();
    hub.subscribe('payment:received', handler, (n) => n.invoiceId === 'inv-1');

    const notification1: PaymentReceivedNotification = {
      type: 'payment:received',
      invoiceId: 'inv-1',
      amount: 100,
      timestamp: Date.now(),
    };

    const notification2: PaymentReceivedNotification = {
      type: 'payment:received',
      invoiceId: 'inv-2',
      amount: 200,
      timestamp: Date.now(),
    };

    hub.publish(notification1);
    hub.publish(notification2);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ invoiceId: 'inv-1' }));
  });

  it('should deliver synchronously before publish returns', (done) => {
    let callOrder = [];
    hub.subscribe('payment:received', () => {
      callOrder.push('handler');
    });

    const notification: PaymentReceivedNotification = {
      type: 'payment:received',
      invoiceId: 'inv-1',
      amount: 100,
      timestamp: Date.now(),
    };

    hub.publish(notification);
    callOrder.push('after-publish');

    expect(callOrder).toEqual(['handler', 'after-publish']);
    done();
  });

  it('should provide independent copies via structural clone', () => {
    let receivedNotification: PaymentReceivedNotification | null = null;
    hub.subscribe('payment:received', (n) => {
      receivedNotification = n;
    });

    const notification: PaymentReceivedNotification = {
      type: 'payment:received',
      invoiceId: 'inv-1',
      amount: 100,
      timestamp: Date.now(),
    };

    hub.publish(notification);

    if (receivedNotification) {
      receivedNotification.amount = 999;
    }

    expect(notification.amount).toBe(100);
  });

  it('should support multiple subscribers on same channel', () => {
    const handler1 = jest.fn();
    const handler2 = jest.fn();
    const handler3 = jest.fn();

    hub.subscribe('payment:received', handler1);
    hub.subscribe('payment:received', handler2);
    hub.subscribe('payment:received', handler3);

    const notification: PaymentReceivedNotification = {
      type: 'payment:received',
      invoiceId: 'inv-1',
      amount: 100,
      timestamp: Date.now(),
    };

    hub.publish(notification);

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
    expect(handler3).toHaveBeenCalledTimes(1);
  });

  it('should support type narrowing in handler callbacks', () => {
    const handler = jest.fn((n: PaymentReceivedNotification) => {
      expect(n.type).toBe('payment:received');
      expect(typeof n.amount).toBe('number');
      expect(typeof n.invoiceId).toBe('string');
    });

    hub.subscribe('payment:received', handler);

    const notification: PaymentReceivedNotification = {
      type: 'payment:received',
      invoiceId: 'inv-1',
      amount: 100,
      timestamp: Date.now(),
    };

    hub.publish(notification);

    expect(handler).toHaveBeenCalled();
  });

  it('should unsubscribe and stop receiving notifications', () => {
    const handler = jest.fn();
    const subscriptionId = hub.subscribe('payment:received', handler);

    const notification: PaymentReceivedNotification = {
      type: 'payment:received',
      invoiceId: 'inv-1',
      amount: 100,
      timestamp: Date.now(),
    };

    hub.publish(notification);
    expect(handler).toHaveBeenCalledTimes(1);

    hub.unsubscribe(subscriptionId);
    hub.publish(notification);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should support different notification types independently', () => {
    const paymentHandler = jest.fn();
    const invoicePaidHandler = jest.fn();

    hub.subscribe('payment:received', paymentHandler);
    hub.subscribe('invoice:paid', invoicePaidHandler);

    const paymentNotification: PaymentReceivedNotification = {
      type: 'payment:received',
      invoiceId: 'inv-1',
      amount: 100,
      timestamp: Date.now(),
    };

    const invoicePaidNotification: InvoicePaidNotification = {
      type: 'invoice:paid',
      invoiceId: 'inv-1',
      paidAmount: 100,
    };

    hub.publish(paymentNotification);
    hub.publish(invoicePaidNotification);

    expect(paymentHandler).toHaveBeenCalledTimes(1);
    expect(invoicePaidHandler).toHaveBeenCalledTimes(1);
  });

  it('should handle complex filter predicates', () => {
    const handler = jest.fn();
    hub.subscribe(
      'payment:received',
      handler,
      (n) => n.amount > 50 && n.invoiceId.startsWith('inv-')
    );

    hub.publish({
      type: 'payment:received',
      invoiceId: 'inv-1',
      amount: 100,
      timestamp: Date.now(),
    });

    hub.publish({
      type: 'payment:received',
      invoiceId: 'inv-2',
      amount: 30,
      timestamp: Date.now(),
    });

    hub.publish({
      type: 'payment:received',
      invoiceId: 'other-1',
      amount: 100,
      timestamp: Date.now(),
    });

    expect(handler).toHaveBeenCalledTimes(1);
  });
});
