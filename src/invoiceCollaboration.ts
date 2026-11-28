/**
 * Invoice Collaboration Module (#1053)
 *
 * Provides multi-stakeholder collaboration on invoices including threaded comments,
 * mentions, multi-approver authorization workflows, and notification dispatching.
 */

import { TypedEventEmitter } from "./events/TypedEventEmitter.js";
import {
  CommentNotFoundError,
  ApprovalRequestNotFoundError,
  UnauthorizedCollaborationError,
} from "./errors.js";
import { diffInvoices } from "./diff.js";
import type { Invoice } from "./types.js";

// ---------------------------------------------------------------------------
// Types & Interfaces
// ---------------------------------------------------------------------------

/** A single comment on an invoice. */
export interface InvoiceComment {
  /** Unique comment identifier. */
  id: string;
  /** Target invoice ID. */
  invoiceId: string;
  /** Stellar address or identifier of comment author. */
  author: string;
  /** Text content of the comment. */
  content: string;
  /** ID of parent comment if this is a reply in a thread. */
  parentId?: string;
  /** List of addresses/handles mentioned via @mentions. */
  mentions: string[];
  /** Unix timestamp (ms) when created. */
  createdAt: number;
  /** Unix timestamp (ms) when last edited. */
  updatedAt?: number;
  /** Whether this comment has been marked deleted. */
  isDeleted?: boolean;
}

/** Threaded comment tree structure. */
export interface ThreadedComment extends InvoiceComment {
  /** Direct replies to this comment. */
  replies: ThreadedComment[];
}

/** Individual decision made by an approver. */
export interface ApprovalDecision {
  approver: string;
  decision: "approved" | "rejected";
  notes?: string;
  timestamp: number;
}

/** Status of an approval workflow request. */
export type ApprovalRequestStatus = "pending" | "approved" | "rejected" | "expired";

/** Multi-party approval request on an invoice. */
export interface ApprovalRequest {
  id: string;
  invoiceId: string;
  requestedBy: string;
  title?: string;
  description?: string;
  requiredApprovers: string[];
  /** Minimum number of approvals needed (defaults to requiredApprovers.length). */
  minApprovals: number;
  /** Expiration timestamp (ms). */
  deadline?: number;
  status: ApprovalRequestStatus;
  decisions: ApprovalDecision[];
  createdAt: number;
  updatedAt: number;
}

/** Aggregated approval summary for an invoice. */
export interface InvoiceApprovalSummary {
  invoiceId: string;
  isApproved: boolean;
  isRejected: boolean;
  isPending: boolean;
  activeRequests: number;
  approvedCount: number;
  requiredCount: number;
  pendingApprovers: string[];
  approvedBy: string[];
  rejectedBy: string[];
}

/** Types of notifications emitted by collaboration events. */
export type CollaborationNotificationType =
  | "comment_added"
  | "mention"
  | "reply"
  | "approval_requested"
  | "approval_decision"
  | "approval_completed";

/** Notification sent to a collaborator. */
export interface CollaborationNotification {
  id: string;
  recipient: string;
  type: CollaborationNotificationType;
  invoiceId: string;
  actor: string;
  message: string;
  timestamp: number;
  read: boolean;
  metadata?: Record<string, unknown>;
}

/** Notification callback handler. */
export type CollaborationNotificationHandler = (
  notification: CollaborationNotification,
) => void | Promise<void>;

/** Collaboration role granted to a stakeholder on an invoice. */
export type CollaborationRole = "owner" | "editor" | "viewer";

/** A recorded field-level change to an invoice attributed to a collaborator. */
export interface InvoiceChangeRecord {
  id: string;
  invoiceId: string;
  actor: string;
  timestamp: number;
  /** Field-level diffs between the previous and next invoice state. */
  changes: Array<{ field: string; before: unknown; after: unknown }>;
}

/** A single activity log entry for a collaboration action. */
export interface CollaborationActivity {
  id: string;
  invoiceId: string;
  actor: string;
  action:
    | "comment_added"
    | "comment_updated"
    | "comment_deleted"
    | "approval_requested"
    | "approval_decided"
    | "approval_completed"
    | "permission_granted"
    | "permission_revoked"
    | "invoice_changed";
  timestamp: number;
  details?: Record<string, unknown>;
}

/** Event map for InvoiceCollaborationManager. */
export type CollaborationEventMap = {
  "comment:added": { comment: InvoiceComment };
  "comment:updated": { comment: InvoiceComment };
  "comment:deleted": { commentId: string; invoiceId: string };
  "approval:requested": { request: ApprovalRequest };
  "approval:decided": { request: ApprovalRequest; decision: ApprovalDecision };
  "approval:completed": { request: ApprovalRequest };
  "notification:sent": { notification: CollaborationNotification };
  "permission:granted": { invoiceId: string; actor: string; role: CollaborationRole };
  "permission:revoked": { invoiceId: string; actor: string };
  "invoice:changed": { record: InvoiceChangeRecord };
  "activity:logged": { activity: CollaborationActivity };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractMentions(text: string): string[] {
  const matches = text.match(/@([A-Za-z0-9_]{3,})/g);
  if (!matches) return [];
  return Array.from(new Set(matches.map((m) => m.slice(1))));
}

// ---------------------------------------------------------------------------
// InvoiceCollaborationManager
// ---------------------------------------------------------------------------

/**
 * Synchronous, in-memory role-based ACL for invoice collaboration.
 *
 * Distinct from the generic binary {@link AclManager} in `accessControl.ts`
 * (grant/revoke/check a single yes-or-no permission): this one tracks which
 * {@link CollaborationRole} each stakeholder holds per invoice.
 */
class CollaborationAclManager {
  private readonly roles = new Map<string, Map<string, CollaborationRole>>();

  grant(invoiceId: string, actor: string, role: CollaborationRole): void {
    let perInvoice = this.roles.get(invoiceId);
    if (!perInvoice) {
      perInvoice = new Map();
      this.roles.set(invoiceId, perInvoice);
    }
    perInvoice.set(actor, role);
  }

  revoke(invoiceId: string, actor: string): boolean {
    const perInvoice = this.roles.get(invoiceId);
    return perInvoice ? perInvoice.delete(actor) : false;
  }

  getRole(invoiceId: string, actor: string): CollaborationRole | undefined {
    return this.roles.get(invoiceId)?.get(actor);
  }
}

/**
 * Manages comments, threaded conversations, multi-approver authorization,
 * and stakeholder notifications for invoices.
 */
export class InvoiceCollaborationManager extends TypedEventEmitter<CollaborationEventMap> {
  private readonly comments = new Map<string, InvoiceComment>();
  private readonly commentsByInvoice = new Map<string, string[]>();
  private readonly approvalRequests = new Map<string, ApprovalRequest>();
  private readonly requestsByInvoice = new Map<string, string[]>();
  private readonly notifications: CollaborationNotification[] = [];
  private readonly notificationHandlers = new Set<CollaborationNotificationHandler>();
  private readonly acl = new CollaborationAclManager();
  private readonly changeRecords = new Map<string, InvoiceChangeRecord[]>();
  private readonly activities: CollaborationActivity[] = [];

  private commentSeq = 0;
  private requestSeq = 0;
  private notificationSeq = 0;
  private changeSeq = 0;
  private activitySeq = 0;

  // ---------------------------------------------------------------------------
  // Permissions
  // ---------------------------------------------------------------------------

  /**
   * Grant a collaboration role to a stakeholder on an invoice.
   */
  grantPermission(invoiceId: string, actor: string, role: CollaborationRole): void {
    this.acl.grant(invoiceId, actor, role);
    this.emit("permission:granted", { invoiceId, actor, role });
    this.logActivity(invoiceId, actor, "permission_granted", { role });
  }

  /**
   * Revoke a stakeholder's collaboration role on an invoice.
   */
  revokePermission(invoiceId: string, actor: string): boolean {
    const removed = this.acl.revoke(invoiceId, actor);
    if (removed) {
      this.emit("permission:revoked", { invoiceId, actor });
      this.logActivity(invoiceId, actor, "permission_revoked");
    }
    return removed;
  }

  /**
   * Return the role of a stakeholder on an invoice, if any.
   */
  getRole(invoiceId: string, actor: string): CollaborationRole | undefined {
    return this.acl.getRole(invoiceId, actor);
  }

  private assertPermission(
    invoiceId: string,
    actor: string,
    action: string,
    required: CollaborationRole[],
  ): void {
    const role = this.acl.getRole(invoiceId, actor);
    if (!role || !required.includes(role)) {
      throw new UnauthorizedCollaborationError(
        actor,
        action,
        `Requires one of roles: ${required.join(", ")}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Change Tracking
  // ---------------------------------------------------------------------------

  /**
   * Record field-level changes between two invoice states, attributed to a collaborator.
   */
  recordInvoiceChange(
    invoiceId: string,
    actor: string,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ): InvoiceChangeRecord {
    this.assertPermission(invoiceId, actor, "record invoice change", ["owner", "editor"]);

    const diffs = diffInvoices(before as unknown as Invoice, after as unknown as Invoice);
    const record: InvoiceChangeRecord = {
      id: `change-${++this.changeSeq}`,
      invoiceId,
      actor,
      timestamp: Date.now(),
      changes: diffs.map((d) => ({ field: d.field, before: d.before, after: d.after })),
    };

    const list = this.changeRecords.get(invoiceId) ?? [];
    list.push(record);
    this.changeRecords.set(invoiceId, list);

    this.emit("invoice:changed", { record });
    this.logActivity(invoiceId, actor, "invoice_changed", { changes: record.changes });
    return record;
  }

  /**
   * Return all recorded change history for an invoice.
   */
  getChangeHistory(invoiceId: string): InvoiceChangeRecord[] {
    return (this.changeRecords.get(invoiceId) ?? []).map((r) => ({ ...r }));
  }

  // ---------------------------------------------------------------------------
  // Activity Logging
  // ---------------------------------------------------------------------------

  private logActivity(
    invoiceId: string,
    actor: string,
    action: CollaborationActivity["action"],
    details?: Record<string, unknown>,
  ): CollaborationActivity {
    const activity: CollaborationActivity = {
      id: `activity-${++this.activitySeq}`,
      invoiceId,
      actor,
      action,
      timestamp: Date.now(),
      details,
    };
    this.activities.push(activity);
    this.emit("activity:logged", { activity });
    return activity;
  }

  /**
   * Return activity log entries for an invoice.
   */
  getActivityLog(invoiceId: string): CollaborationActivity[] {
    return this.activities.filter((a) => a.invoiceId === invoiceId).map((a) => ({ ...a }));
  }

  // ---------------------------------------------------------------------------
  // Comments & Threading
  // ---------------------------------------------------------------------------

  /**
   * Add a new comment or threaded reply to an invoice.
   *
   * Automatically parses `@mentions` and dispatches notifications to
   * mentioned parties and thread parents.
   */
  addComment(params: {
    invoiceId: string;
    author: string;
    content: string;
    parentId?: string;
  }): InvoiceComment {
    if (!params.content.trim()) {
      throw new Error("Comment content cannot be empty");
    }

    if (params.parentId) {
      const parent = this.comments.get(params.parentId);
      if (!parent || parent.invoiceId !== params.invoiceId) {
        throw new CommentNotFoundError(params.parentId);
      }
    }

    const mentions = extractMentions(params.content);
    const commentId = `comment-${++this.commentSeq}`;

    const comment: InvoiceComment = {
      id: commentId,
      invoiceId: params.invoiceId,
      author: params.author,
      content: params.content,
      parentId: params.parentId,
      mentions,
      createdAt: Date.now(),
      isDeleted: false,
    };

    this.comments.set(commentId, comment);
    const invoiceList = this.commentsByInvoice.get(params.invoiceId) ?? [];
    invoiceList.push(commentId);
    this.commentsByInvoice.set(params.invoiceId, invoiceList);

    this.emit("comment:added", { comment });
    this.logActivity(params.invoiceId, params.author, "comment_added", { commentId });

    // Send notifications
    this.dispatchCommentNotifications(comment);

    return { ...comment };
  }

  /**
   * Return all comments for an invoice in flat chronological order.
   */
  getComments(invoiceId: string): InvoiceComment[] {
    const ids = this.commentsByInvoice.get(invoiceId) ?? [];
    return ids
      .map((id) => this.comments.get(id)!)
      .filter((c) => Boolean(c) && !c.isDeleted)
      .map((c) => ({ ...c }));
  }

  /**
   * Return a clear hierarchical tree of comments and nested replies.
   */
  getThreadedComments(invoiceId: string): ThreadedComment[] {
    const all = this.getComments(invoiceId);
    const commentMap = new Map<string, ThreadedComment>();
    const roots: ThreadedComment[] = [];

    // Initialize threaded wrapper
    for (const c of all) {
      commentMap.set(c.id, { ...c, replies: [] });
    }

    // Build hierarchy
    for (const c of all) {
      const node = commentMap.get(c.id)!;
      if (c.parentId && commentMap.has(c.parentId)) {
        commentMap.get(c.parentId)!.replies.push(node);
      } else {
        roots.push(node);
      }
    }

    return roots;
  }

  /**
   * Edit an existing comment.
   */
  editComment(commentId: string, author: string, newContent: string): InvoiceComment {
    const comment = this.comments.get(commentId);
    if (!comment || comment.isDeleted) {
      throw new CommentNotFoundError(commentId);
    }
    if (comment.author !== author) {
      throw new UnauthorizedCollaborationError(author, "edit comment", "Only the author may edit");
    }

    comment.content = newContent;
    comment.mentions = extractMentions(newContent);
    comment.updatedAt = Date.now();

    this.emit("comment:updated", { comment: { ...comment } });
    this.logActivity(comment.invoiceId, author, "comment_updated", { commentId });
    return { ...comment };
  }

  /**
   * Soft-delete a comment.
   */
  deleteComment(commentId: string, author: string): boolean {
    const comment = this.comments.get(commentId);
    if (!comment || comment.isDeleted) {
      throw new CommentNotFoundError(commentId);
    }
    if (comment.author !== author) {
      throw new UnauthorizedCollaborationError(author, "delete comment", "Only the author may delete");
    }

    comment.isDeleted = true;
    comment.content = "[deleted]";
    comment.updatedAt = Date.now();

    this.emit("comment:deleted", { commentId, invoiceId: comment.invoiceId });
    this.logActivity(comment.invoiceId, author, "comment_deleted", { commentId });
    return true;
  }

  // ---------------------------------------------------------------------------
  // Approvals Workflow
  // ---------------------------------------------------------------------------

  /**
   * Request multi-party approval on an invoice.
   */
  requestApproval(params: {
    invoiceId: string;
    requestedBy: string;
    requiredApprovers: string[];
    minApprovals?: number;
    title?: string;
    description?: string;
    deadline?: number;
  }): ApprovalRequest {
    if (!params.requiredApprovers || params.requiredApprovers.length === 0) {
      throw new Error("Approval request requires at least one approver");
    }

    const minApprovals = params.minApprovals ?? params.requiredApprovers.length;
    if (minApprovals <= 0 || minApprovals > params.requiredApprovers.length) {
      throw new Error(`minApprovals must be between 1 and ${params.requiredApprovers.length}`);
    }

    const requestId = `req-${++this.requestSeq}`;
    const request: ApprovalRequest = {
      id: requestId,
      invoiceId: params.invoiceId,
      requestedBy: params.requestedBy,
      title: params.title,
      description: params.description,
      requiredApprovers: [...params.requiredApprovers],
      minApprovals,
      deadline: params.deadline,
      status: "pending",
      decisions: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.approvalRequests.set(requestId, request);
    const invoiceList = this.requestsByInvoice.get(params.invoiceId) ?? [];
    invoiceList.push(requestId);
    this.requestsByInvoice.set(params.invoiceId, invoiceList);

    this.emit("approval:requested", { request });
    this.logActivity(params.invoiceId, params.requestedBy, "approval_requested", { requestId });

    // Notify approvers
    for (const approver of params.requiredApprovers) {
      this.sendNotification({
        recipient: approver,
        type: "approval_requested",
        invoiceId: params.invoiceId,
        actor: params.requestedBy,
        message: `Approval requested for invoice "${params.invoiceId}"${params.title ? `: ${params.title}` : ""}`,
      });
    }

    return { ...request };
  }

  /**
   * Submit an approval or rejection decision.
   */
  submitDecision(params: {
    requestId: string;
    approver: string;
    decision: "approved" | "rejected";
    notes?: string;
  }): ApprovalRequest {
    const request = this.approvalRequests.get(params.requestId);
    if (!request) {
      throw new ApprovalRequestNotFoundError(params.requestId);
    }

    if (!request.requiredApprovers.includes(params.approver)) {
      throw new UnauthorizedCollaborationError(
        params.approver,
        "submit approval decision",
        "Not in required approvers list",
      );
    }
    if (request.status !== "pending") {
      throw new Error(`Approval request is already in "${request.status}" state`);
    }

    const decision: ApprovalDecision = {
      approver: params.approver,
      decision: params.decision,
      notes: params.notes,
      timestamp: Date.now(),
    };

    // Replace previous decision by same approver if exists
    const existingIdx = request.decisions.findIndex((d) => d.approver === params.approver);
    if (existingIdx !== -1) {
      request.decisions[existingIdx] = decision;
    } else {
      request.decisions.push(decision);
    }

    // Evaluate workflow state
    const approvedCount = request.decisions.filter((d) => d.decision === "approved").length;
    const rejectedCount = request.decisions.filter((d) => d.decision === "rejected").length;

    if (approvedCount >= request.minApprovals) {
      request.status = "approved";
    } else if (request.requiredApprovers.length - rejectedCount < request.minApprovals) {
      // Not enough remaining approvers can approve to reach quorum
      request.status = "rejected";
    }

    request.updatedAt = Date.now();

    this.emit("approval:decided", { request, decision });
    this.logActivity(request.invoiceId, params.approver, "approval_decided", {
      requestId: request.id,
      decision: params.decision,
    });

    // Notify requester
    this.sendNotification({
      recipient: request.requestedBy,
      type: "approval_decision",
      invoiceId: request.invoiceId,
      actor: params.approver,
      message: `${params.approver} ${params.decision} approval request "${request.id}"${params.notes ? ` (${params.notes})` : ""}`,
    });

    if (request.status !== "pending") {
      this.emit("approval:completed", { request });
      this.logActivity(request.invoiceId, params.approver, "approval_completed", {
        requestId: request.id,
        status: request.status,
      });

      // Notify all stakeholders
      for (const approver of request.requiredApprovers) {
        this.sendNotification({
          recipient: approver,
          type: "approval_completed",
          invoiceId: request.invoiceId,
          actor: params.approver,
          message: `Approval workflow "${request.id}" has concluded with status: ${request.status}`,
        });
      }
    }

    return { ...request };
  }

  /**
   * Return all approval requests for an invoice.
   */
  getApprovalRequests(invoiceId: string): ApprovalRequest[] {
    const ids = this.requestsByInvoice.get(invoiceId) ?? [];
    return ids.map((id) => this.approvalRequests.get(id)!).filter(Boolean);
  }

  /**
   * Aggregate approval status for an invoice.
   */
  getApprovalStatus(invoiceId: string): InvoiceApprovalSummary {
    const requests = this.getApprovalRequests(invoiceId);
    if (requests.length === 0) {
      return {
        invoiceId,
        isApproved: false,
        isRejected: false,
        isPending: false,
        activeRequests: 0,
        approvedCount: 0,
        requiredCount: 0,
        pendingApprovers: [],
        approvedBy: [],
        rejectedBy: [],
      };
    }

    const latest = requests[requests.length - 1]!;
    const approvedBy = latest.decisions.filter((d) => d.decision === "approved").map((d) => d.approver);
    const rejectedBy = latest.decisions.filter((d) => d.decision === "rejected").map((d) => d.approver);
    const decided = new Set(latest.decisions.map((d) => d.approver));
    const pendingApprovers = latest.requiredApprovers.filter((a) => !decided.has(a));

    return {
      invoiceId,
      isApproved: latest.status === "approved",
      isRejected: latest.status === "rejected",
      isPending: latest.status === "pending",
      activeRequests: requests.filter((r) => r.status === "pending").length,
      approvedCount: approvedBy.length,
      requiredCount: latest.minApprovals,
      pendingApprovers,
      approvedBy,
      rejectedBy,
    };
  }

  // ---------------------------------------------------------------------------
  // Notifications
  // ---------------------------------------------------------------------------

  /**
   * Register a notification handler/subscriber.
   */
  onNotification(handler: CollaborationNotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  /**
   * Send a notification to a collaborator and notify subscribers.
   */
  private sendNotification(data: Omit<CollaborationNotification, "id" | "timestamp" | "read">): CollaborationNotification {
    const notification: CollaborationNotification = {
      id: `notif-${++this.notificationSeq}`,
      timestamp: Date.now(),
      read: false,
      ...data,
    };

    this.notifications.push(notification);
    this.emit("notification:sent", { notification });

    for (const handler of this.notificationHandlers) {
      try {
        void handler(notification);
      } catch {
        // Safe dispatch
      }
    }

    return notification;
  }

  /**
   * Retrieve notifications for a specific recipient address.
   */
  getNotifications(recipient: string, unreadOnly = false): CollaborationNotification[] {
    return this.notifications
      .filter((n) => n.recipient === recipient && (!unreadOnly || !n.read))
      .map((n) => ({ ...n }));
  }

  /**
   * Retrieve notifications for a specific invoice.
   */
  getInvoiceNotifications(invoiceId: string): CollaborationNotification[] {
    return this.notifications.filter((n) => n.invoiceId === invoiceId).map((n) => ({ ...n }));
  }

  /**
   * Mark a specific notification as read.
   */
  markNotificationAsRead(notificationId: string, actor?: string): boolean {
    const notif = this.notifications.find((n) => n.id === notificationId);
    if (!notif) return false;
    if (actor !== undefined) {
      this.assertPermission(notif.invoiceId, actor, "mark notification read", [
        "owner",
        "editor",
        "viewer",
      ]);
    }
    notif.read = true;
    return true;
  }

  /**
   * Mark all notifications for a recipient as read.
   */
  markAllNotificationsAsRead(recipient: string, invoiceId?: string): number {
    let count = 0;
    for (const notif of this.notifications) {
      if (notif.recipient !== recipient || notif.read) continue;
      if (invoiceId !== undefined) {
        this.assertPermission(invoiceId, recipient, "mark notifications read", [
          "owner",
          "editor",
          "viewer",
        ]);
        if (notif.invoiceId !== invoiceId) continue;
      }
      notif.read = true;
      count++;
    }
    return count;
  }

  private dispatchCommentNotifications(comment: InvoiceComment): void {
    // Notify mentioned users
    for (const handle of comment.mentions) {
      if (handle !== comment.author) {
        this.sendNotification({
          recipient: handle,
          type: "mention",
          invoiceId: comment.invoiceId,
          actor: comment.author,
          message: `${comment.author} mentioned you on invoice "${comment.invoiceId}"`,
        });
      }
    }

    // Notify parent comment author if reply
    if (comment.parentId) {
      const parent = this.comments.get(comment.parentId);
      if (parent && parent.author !== comment.author && !comment.mentions.includes(parent.author)) {
        this.sendNotification({
          recipient: parent.author,
          type: "reply",
          invoiceId: comment.invoiceId,
          actor: comment.author,
          message: `${comment.author} replied to your comment on invoice "${comment.invoiceId}"`,
        });
      }
    }
  }
}
