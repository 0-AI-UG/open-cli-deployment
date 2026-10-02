import { corsHeaders } from "../lib/cors.ts";
import { requireAuthenticated } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../shared/db.ts";

export async function handleListUsers(request: Request): Promise<Response> {
  try {
    await requireAuthenticated(request);
    const users = db.getUsers();

    return Response.json(
      {
        users: users.map((u) => ({
          id: u.id,
          username: u.username,
          webauthnEnabled: u.webauthn_enabled === 1,
          createdAt: u.created_at,
        })),
      },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleCreateUser(request: Request): Promise<Response> {
  try {
    await requireAuthenticated(request);
    const body = await request.json() as { username?: string; password?: string };

    if (!body.username || !body.password) {
      return Response.json(
        { error: "Username and password are required" },
        { status: 400, headers: corsHeaders },
      );
    }

    if (body.password.length < 8) {
      return Response.json(
        { error: "Password must be at least 8 characters" },
        { status: 400, headers: corsHeaders },
      );
    }

    const existing = db.getUserByUsername(body.username);
    if (existing) {
      return Response.json(
        { error: "Username already taken" },
        { status: 409, headers: corsHeaders },
      );
    }

    const id = crypto.randomUUID();
    const passwordHash = await Bun.password.hash(body.password, "bcrypt");
    db.insertUser({ id, username: body.username, password_hash: passwordHash });

    return Response.json(
      {
        id,
        username: body.username,
        createdAt: new Date().toISOString(),
      },
      { status: 201, headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleUpdateUser(request: Request, userId: string): Promise<Response> {
  try {
    await requireAuthenticated(request);
    const body = await request.json() as { password?: string };

    const user = db.getUserById(userId);
    if (!user) {
      return Response.json(
        { error: "User not found" },
        { status: 404, headers: corsHeaders },
      );
    }

    if (body.password) {
      if (body.password.length < 8) {
        return Response.json(
          { error: "Password must be at least 8 characters" },
          { status: 400, headers: corsHeaders },
        );
      }
      const hash = await Bun.password.hash(body.password, "bcrypt");
      db.updateUserPassword(userId, hash);
    }

    return Response.json({ success: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDeleteUser(request: Request, targetId: string): Promise<Response> {
  try {
    const { userId: actorId } = await requireAuthenticated(request);

    if (targetId === actorId) {
      return Response.json(
        { error: "Cannot delete your own account" },
        { status: 400, headers: corsHeaders },
      );
    }

    const user = db.getUserById(targetId);
    if (!user) {
      return Response.json(
        { error: "User not found" },
        { status: 404, headers: corsHeaders },
      );
    }

    db.deleteUser(targetId);
    return Response.json({ success: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
