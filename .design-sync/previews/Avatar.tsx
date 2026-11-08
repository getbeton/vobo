import { Avatar, AvatarFallback } from 'vobo';

export const Fallback = () => (
  <div style={{ display: 'flex', gap: 12 }}>
    <Avatar><AvatarFallback>AK</AvatarFallback></Avatar>
    <Avatar><AvatarFallback>MR</AvatarFallback></Avatar>
    <Avatar><AvatarFallback>JS</AvatarFallback></Avatar>
  </div>
);

export const Sizes = () => (
  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
    <Avatar className="size-6"><AvatarFallback className="text-xs">AK</AvatarFallback></Avatar>
    <Avatar><AvatarFallback>AK</AvatarFallback></Avatar>
    <Avatar className="size-12"><AvatarFallback>AK</AvatarFallback></Avatar>
  </div>
);
