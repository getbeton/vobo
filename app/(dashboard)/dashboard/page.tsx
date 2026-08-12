'use client';

import { useActionState, Suspense } from 'react';
import useSWR from 'swr';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Loader2, PlusCircle } from 'lucide-react';
import { WorkspaceDataWithMembers, User } from '@/lib/db/schema';
import {
  removeWorkspaceMember,
  inviteWorkspaceMember,
} from '@/app/(login)/actions';

type ActionState = {
  error?: string;
  success?: string;
};

const fetcher = (url: string) => fetch(url).then((res) => res.json());

function MembersSkeleton() {
  return (
    <Card className="mb-8 h-[140px]">
      <CardHeader>
        <CardTitle>Workspace Members</CardTitle>
      </CardHeader>
    </Card>
  );
}

function Members() {
  const { data: workspace } = useSWR<WorkspaceDataWithMembers>(
    '/api/workspace',
    fetcher
  );
  const [removeState, removeAction, isRemovePending] = useActionState<
    ActionState,
    FormData
  >(removeWorkspaceMember, {});

  const getUserDisplayName = (user: Pick<User, 'id' | 'name' | 'email'>) =>
    user.name || user.email || 'Unknown User';

  if (!workspace?.members?.length) {
    return (
      <Card className="mb-8">
        <CardHeader>
          <CardTitle>Workspace Members</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">No members yet.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="mb-8">
      <CardHeader>
        <CardTitle>Workspace Members</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-4">
          {workspace.members.map((member, index) => (
            <li key={member.id} className="flex items-center justify-between">
              <div className="flex items-center space-x-4">
                <Avatar>
                  <AvatarFallback>
                    {getUserDisplayName(member.user)
                      .split(' ')
                      .map((n) => n[0])
                      .join('')}
                  </AvatarFallback>
                </Avatar>
                <div>
                  <p className="font-medium">
                    {getUserDisplayName(member.user)}
                  </p>
                  <p className="text-sm text-muted-foreground capitalize">
                    {member.role}
                  </p>
                </div>
              </div>
              {index > 0 ? (
                <form action={removeAction}>
                  <input type="hidden" name="memberId" value={member.id} />
                  <Button
                    type="submit"
                    variant="outline"
                    size="sm"
                    disabled={isRemovePending}
                  >
                    {isRemovePending ? 'Removing...' : 'Remove'}
                  </Button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
        {removeState?.error && (
          <p className="text-red-500 mt-4">{removeState.error}</p>
        )}
      </CardContent>
    </Card>
  );
}

function InviteMemberSkeleton() {
  return (
    <Card className="h-[260px]">
      <CardHeader>
        <CardTitle>Invite Member</CardTitle>
      </CardHeader>
    </Card>
  );
}

function InviteMember() {
  const { data: workspace } = useSWR<WorkspaceDataWithMembers>(
    '/api/workspace',
    fetcher
  );
  const [inviteState, inviteAction, isInvitePending] = useActionState<
    ActionState,
    FormData
  >(inviteWorkspaceMember, {});

  return (
    <Card>
      <CardHeader>
        <CardTitle>Invite Member</CardTitle>
      </CardHeader>
      <CardContent>
        <form action={inviteAction} className="space-y-4">
          <div>
            <Label htmlFor="email" className="mb-2">
              Email
            </Label>
            <Input
              id="email"
              name="email"
              type="email"
              placeholder="Enter email"
              required
            />
          </div>
          <div>
            <Label className="mb-2">Role</Label>
            <RadioGroup
              defaultValue="reviewer"
              name="role"
              className="flex flex-col space-y-2"
            >
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="reviewer" id="reviewer" />
                <Label htmlFor="reviewer">
                  Reviewer — works the queue, judges artifacts
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="operator" id="operator" />
                <Label htmlFor="operator">
                  Operator — queues, policies, escalation rulings
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="admin" id="admin" />
                <Label htmlFor="admin">
                  Admin — members, roles, workspace settings
                </Label>
              </div>
            </RadioGroup>
          </div>
          <Button type="submit" disabled={isInvitePending}>
            {isInvitePending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Inviting...
              </>
            ) : (
              <>
                <PlusCircle className="mr-2 h-4 w-4" />
                Invite Member
              </>
            )}
          </Button>
        </form>
        {inviteState?.error && (
          <p className="text-red-500 mt-4">{inviteState.error}</p>
        )}
        {inviteState?.success && (
          <p className="text-green-500 mt-4">{inviteState.success}</p>
        )}
      </CardContent>
    </Card>
  );
}

export default function WorkspaceSettingsPage() {
  return (
    <section className="flex-1 p-4 lg:p-8">
      <h1 className="text-lg lg:text-2xl font-medium mb-6">
        Workspace Settings
      </h1>
      <Suspense fallback={<MembersSkeleton />}>
        <Members />
      </Suspense>
      <Suspense fallback={<InviteMemberSkeleton />}>
        <InviteMember />
      </Suspense>
    </section>
  );
}
