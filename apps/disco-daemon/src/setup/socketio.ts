/**
 * Socket.IO transport for the current Disco session runtime.
 *
 * This layer owns authentication, tenant/user notification rooms, build
 * identity, and private executor-task control rooms. Historical Board cursor
 * presence and Branch-backed web-terminal relays intentionally do not live in
 * the current runtime.
 */

import {
  type ResolvedMultiTenancyConfig,
  resolveTenantContext,
  SOCKET_IO_MAX_BUFFER_SIZE_BYTES,
} from '@disco/core/config';
import { shortId } from '@disco/core/db';
import type { Application } from '@disco/core/feathers';
import type { AuthenticatedUser, TenantContext } from '@disco/core/types';
import jwt from 'jsonwebtoken';
import type { Server, ServerOptions, Socket } from 'socket.io';
import { isExecutorSessionTokenPayload } from '../auth/executor-session-token.js';
import { RUNTIME_JWT_AUDIENCE, RUNTIME_JWT_ISSUER } from '../auth/runtime-tokens.js';
import { tenantChannelName, tenantUserChannelName } from '../realtime/routing.js';
import {
  executorTaskChannelName,
  joinExecutorTaskChannel,
  leaveAllExecutorTaskChannels,
  leaveAllSessionStreamChannels,
  leaveAllTenantChannels,
} from '../utils/realtime-publish.js';
import type { BuildInfo } from './build-info.js';
import type { CorsOrigin } from './cors.js';

interface FeathersSocket extends Socket {
  feathers?: {
    user?: AuthenticatedUser;
  };
  data: {
    isService?: boolean;
    tenant?: TenantContext;
  };
  tenant?: TenantContext;
  handshake: Socket['handshake'] & { headers?: Record<string, string | string[] | undefined> };
}

export interface SocketIOOptions {
  corsOrigin: CorsOrigin;
  jwtSecret: string;
  credentialsAllowed: boolean;
  buildInfo?: BuildInfo;
  workIdentity?: { instanceId: string; bootId: string };
  multiTenancy?: ResolvedMultiTenancyConfig;
  adapter?: ServerOptions['adapter'];
  onServerCreated?: (io: Server) => void;
}

export interface SocketAuthState {
  userId: string | null;
  isService: boolean;
  tenant?: TenantContext;
}

export interface SocketIOResult {
  socketServer: Server | null;
}

/** Return the trusted identity already attached by the handshake or Feathers auth. */
export function getSocketAuthState(socket: Socket): SocketAuthState {
  const current = socket as FeathersSocket;
  const user = current.feathers?.user;
  const tenant = current.data?.tenant;
  if (user?._isServiceAccount === true || current.data?.isService === true) {
    return tenant
      ? { userId: null, isService: true, tenant }
      : { userId: null, isService: true };
  }
  if (user?.user_id) {
    return tenant
      ? { userId: user.user_id, isService: false, tenant }
      : { userId: user.user_id, isService: false };
  }
  return tenant
    ? { userId: null, isService: false, tenant }
    : { userId: null, isService: false };
}

function isAuthenticated(auth: SocketAuthState): boolean {
  return auth.userId !== null || auth.isService;
}

export function createSocketIOConfig(
  app: Application,
  options: SocketIOOptions
): {
  serverOptions: object;
  callback: (io: Server) => void;
  getSocketServer: () => Server | null;
} {
  const { corsOrigin, jwtSecret, credentialsAllowed, buildInfo, multiTenancy } = options;
  let socketServer: Server | null = null;

  const serverOptions = {
    cors: {
      origin: corsOrigin,
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      credentials: credentialsAllowed,
    },
    pingTimeout: 60_000,
    pingInterval: 25_000,
    maxHttpBufferSize: SOCKET_IO_MAX_BUFFER_SIZE_BYTES,
    transports: ['websocket', 'polling'],
    ...(options.adapter ? { adapter: options.adapter } : {}),
  };

  const callback = (io: Server) => {
    socketServer = io;
    options.onServerCreated?.(io);

    let activeConnections = 0;
    let unauthenticatedDisconnects = 0;
    const authenticatedIdentities = new WeakMap<Socket, string>();

    const logAuthenticated = (socket: Socket, userId?: string) => {
      const identity = userId ? `user:${userId}` : 'service';
      if (authenticatedIdentities.get(socket) === identity) return;
      authenticatedIdentities.set(socket, identity);
      console.log(
        userId
          ? `socket authenticated: ${socket.id} user:${shortId(userId)}`
          : `socket authenticated: ${socket.id} service`
      );
    };

    io.use(async (socket, next) => {
      try {
        const token =
          socket.handshake.auth?.token ||
          socket.handshake.headers?.authorization?.replace('Bearer ', '');
        if (!token) return next();

        const decoded = jwt.verify(token, jwtSecret, {
          issuer: RUNTIME_JWT_ISSUER,
          audience: RUNTIME_JWT_AUDIENCE,
        }) as { sub: string; type?: string; role?: string };
        if (
          decoded.type !== undefined &&
          decoded.type !== 'access' &&
          decoded.type !== 'service'
        ) {
          return next(new Error('Invalid token type'));
        }

        const tenant = multiTenancy
          ? resolveTenantContext(multiTenancy, {
              authPayload: decoded,
              headers: socket.handshake.headers as Record<string, unknown>,
            })
          : undefined;
        const current = socket as FeathersSocket;

        if (decoded.type === 'service') {
          current.feathers = {
            user: {
              user_id: 'executor-service',
              username: 'executor-service',
              role: 'service',
              _isServiceAccount: true,
            },
          };
          current.data.isService = true;
          if (tenant) {
            current.data.tenant = tenant;
            current.tenant = tenant;
          }
          logAuthenticated(socket);
          return next();
        }

        const user = await app.service('users').get(decoded.sub as import('@disco/core/types').UUID, {
          ...(tenant ? { tenant } : {}),
          authentication: { payload: decoded },
        } as never);
        current.feathers = { user: tenant ? { ...user, tenant_id: tenant.tenant_id } : user };
        if (tenant) {
          current.data.tenant = tenant;
          current.tenant = tenant;
        }
        logAuthenticated(socket, user.user_id);
        next();
      } catch (error) {
        console.error(`WebSocket authentication failed for ${socket.id}:`, error);
        next(new Error('Invalid or expired authentication token'));
      }
    });

    io.on('connection', (socket) => {
      activeConnections++;
      const current = socket as FeathersSocket;
      const user = current.feathers?.user;
      console.debug(
        `Socket.io connection established: ${socket.id} (auth: ${user ? 'handshake' : 'anonymous'}, user: ${user ? shortId(user.user_id) : 'unknown'}, total: ${activeConnections})`
      );

      if (buildInfo) {
        socket.emit('server-info', {
          buildSha: buildInfo.sha,
          builtAt: buildInfo.builtAt,
          ...(options.workIdentity
            ? {
                instanceId: options.workIdentity.instanceId,
                bootId: options.workIdentity.bootId,
              }
            : {}),
        });
      }

      if (user?.user_id && user._isServiceAccount !== true) {
        const tenantId = current.data.tenant?.tenant_id;
        if (tenantId) {
          socket.join(tenantChannelName(tenantId));
          socket.join(tenantUserChannelName(tenantId, user.user_id));
        }
      }

      socket.on('disconnect', (reason) => {
        activeConnections--;
        const disconnectedBeforeAuthentication =
          !authenticatedIdentities.has(socket) && !isAuthenticated(getSocketAuthState(socket));
        if (disconnectedBeforeAuthentication) {
          unauthenticatedDisconnects = Math.min(
            unauthenticatedDisconnects + 1,
            Number.MAX_SAFE_INTEGER
          );
        }
        const message = `Socket.io disconnected: ${socket.id} (reason: ${reason}, remaining: ${activeConnections})`;
        if (reason === 'transport error') console.warn(message);
        else if (!disconnectedBeforeAuthentication) console.debug(message);
      });

      socket.on('error', (error) => {
        console.error(`Socket.io error on ${socket.id}:`, error);
      });
    });

    app.on('login', (authResult: unknown, context: { connection?: unknown; params?: unknown }) => {
      if (!context.connection) return;
      const result = authResult as {
        user?: { user_id?: string; _isServiceAccount?: boolean };
      };
      const userId = result.user?.user_id;
      if (!userId) return;

      for (const [, socket] of io.sockets.sockets) {
        const current = socket as FeathersSocket;
        if (current.feathers !== context.connection) continue;
        for (const room of socket.rooms) {
          if (room.startsWith('tenant:')) socket.leave(room);
        }
        delete current.data.tenant;
        delete current.tenant;
        delete current.data.isService;

        const isService = result.user?._isServiceAccount === true;
        logAuthenticated(socket, isService ? undefined : userId);
        let tenant: TenantContext | undefined;
        if (multiTenancy && !isService) {
          try {
            tenant = resolveTenantContext(multiTenancy, { params: context.params as never });
            current.data.tenant = tenant;
            current.tenant = tenant;
          } catch {
            // Channel configuration fails closed when tenant resolution fails.
          }
        }
        if (!isService && tenant) {
          socket.join(tenantChannelName(tenant.tenant_id));
          socket.join(tenantUserChannelName(tenant.tenant_id, userId));
        }
        break;
      }
    });

    app.on('logout', (_authResult: unknown, context: { connection?: unknown }) => {
      if (!context.connection) return;
      for (const [, socket] of io.sockets.sockets) {
        const current = socket as FeathersSocket;
        if (current.feathers !== context.connection) continue;
        for (const room of socket.rooms) {
          if (room.startsWith('tenant:')) socket.leave(room);
        }
        delete current.data.tenant;
        delete current.tenant;
        delete current.data.isService;
        break;
      }
    });

    const metricsInterval = setInterval(() => {
      const disconnectedBeforeAuthentication = unauthenticatedDisconnects;
      unauthenticatedDisconnects = 0;
      console.log(
        `ws_active_connections=${activeConnections} ws_unauthenticated_disconnects=${disconnectedBeforeAuthentication}`
      );
    }, 5 * 60 * 1000);
    metricsInterval.unref();
    io.engine.once('close', () => clearInterval(metricsInterval));
  };

  return {
    serverOptions,
    callback,
    getSocketServer: () => socketServer,
  };
}

/** Configure authenticated Feathers publication channels. */
export function configureChannels(
  app: Application,
  options: { multiTenancy?: ResolvedMultiTenancyConfig } = {}
): void {
  app.on('connection', () => undefined);

  app.on('login', (authResult: unknown, context: { connection?: unknown; params?: unknown }) => {
    if (!context.connection) return;
    const result = authResult as {
      user?: { user_id?: string; username?: string; tenant_id?: string };
      authentication?: { payload?: unknown };
      task_id?: string;
    };

    app.channel('authenticated').leave(context.connection as never);
    leaveAllTenantChannels(app, context.connection);
    leaveAllSessionStreamChannels(app, context.connection);
    leaveAllExecutorTaskChannels(app, context.connection);

    const connection = context.connection as FeathersSocket;
    delete connection.tenant;
    if (connection.data) delete connection.data.tenant;

    const loginParams =
      context.params && typeof context.params === 'object'
        ? (context.params as {
            tenant?: TenantContext;
            tenant_id?: string;
            headers?: Record<string, unknown>;
          })
        : undefined;
    const tenant = options.multiTenancy
      ? resolveTenantContext(options.multiTenancy, {
          params: {
            tenant: loginParams?.tenant,
            tenant_id: loginParams?.tenant_id,
            headers: loginParams?.headers,
            user: result.user,
            authentication: { payload: result.authentication?.payload },
          },
        })
      : undefined;
    if (tenant) {
      connection.tenant = tenant;
      if (connection.data) connection.data.tenant = tenant;
    }

    app.channel('authenticated').join(context.connection as never);
    if (tenant) {
      app.channel(tenantChannelName(tenant.tenant_id)).join(context.connection as never);
      if (result.user?.user_id) {
        app
          .channel(tenantUserChannelName(tenant.tenant_id, result.user.user_id))
          .join(context.connection as never);
      }
    }

    const executorPayload = result.authentication?.payload;
    if (
      isExecutorSessionTokenPayload(executorPayload) &&
      typeof executorPayload.task_id === 'string' &&
      executorPayload.task_id.length > 0 &&
      result.task_id === executorPayload.task_id &&
      tenant
    ) {
      joinExecutorTaskChannel(app, tenant.tenant_id, executorPayload.task_id, context.connection);
      console.debug(
        `Executor connection joined task control room: ${executorTaskChannelName(tenant.tenant_id, executorPayload.task_id)}`
      );
    }
  });

  app.on('logout', (_authResult: unknown, context: { connection?: unknown }) => {
    if (!context.connection) return;
    const connection = context.connection as FeathersSocket;
    app.channel('authenticated').leave(context.connection as never);
    leaveAllExecutorTaskChannels(app, context.connection);
    leaveAllTenantChannels(app, context.connection);
    leaveAllSessionStreamChannels(app, context.connection);
    delete connection.tenant;
    if (connection.data) delete connection.data.tenant;
  });
}
