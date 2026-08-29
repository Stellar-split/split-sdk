export interface RecipientGraphQLResult {
  address: string;
  amount: string;
}

export interface PaymentGraphQLResult {
  payer: string;
  amount: string;
}

export interface InvoiceGraphQLResult {
  id: string;
  creator: string;
  recipients: RecipientGraphQLResult[];
  token: string;
  deadline: number;
  funded: string;
  status: string;
  payments: PaymentGraphQLResult[];
  recurring?: boolean | null;
}

export interface InvoiceQueryResponse {
  invoice: InvoiceGraphQLResult | null;
}

export interface InvoicesByCreatorQueryResponse {
  invoicesByCreator: InvoiceGraphQLResult[];
}

export interface GraphQLQuery<TResponse> {
  query: string;
  variables: Record<string, string>;
}

/**
 * generateGraphQLSchema — builds a GraphQL SDL string from SDK TypeScript interfaces.
 *
 * Type mapping:
 *   bigint  → String  (GraphQL has no native 64-bit int)
 *   string  → String
 *   number  → Int
 *   boolean → Boolean
 */
export function generateGraphQLSchema(): string {
  return `
type Recipient {
  address: String!
  amount: String!
}

type Payment {
  payer: String!
  amount: String!
}

type Invoice {
  id: String!
  creator: String!
  recipients: [Recipient!]!
  token: String!
  deadline: Int!
  funded: String!
  status: String!
  payments: [Payment!]!
  recurring: Boolean
}

type Query {
  invoice(id: String!): Invoice
  invoicesByCreator(address: String!): [Invoice!]!
}
`.trim();
}

export function buildInvoiceQuery(id: string): GraphQLQuery<InvoiceQueryResponse> {
  return {
    query: `
query Invoice($id: String!) {
  invoice(id: $id) {
    id
    creator
    recipients {
      address
      amount
    }
    token
    deadline
    funded
    status
    payments {
      payer
      amount
    }
    recurring
  }
}`.trim(),
    variables: { id },
  };
}

export function buildInvoicesByCreatorQuery(
  address: string,
): GraphQLQuery<InvoicesByCreatorQueryResponse> {
  return {
    query: `
query InvoicesByCreator($address: String!) {
  invoicesByCreator(address: $address) {
    id
    creator
    recipients {
      address
      amount
    }
    token
    deadline
    funded
    status
    payments {
      payer
      amount
    }
    recurring
  }
}`.trim(),
    variables: { address },
  };
}
