/**
 * Room registry: rooms are isolated by construction. A peer is a member of
 * a room only after a successful join, and relaying is only ever done to a
 * peer that is a member of the same room. A message addressed to a peer in
 * another room is rejected, never delivered.
 */

export interface PeerInfo {
  peerId: string;
  name?: string;
}

export class RoomManager {
  private rooms = new Map<string, Map<string, PeerInfo>>();

  /** Add a peer to a room. Returns false when the peer id is already taken in that room. */
  join(room: string, peer: PeerInfo): boolean {
    let members = this.rooms.get(room);
    if (!members) {
      members = new Map();
      this.rooms.set(room, members);
    }
    if (members.has(peer.peerId)) return false;
    members.set(peer.peerId, peer);
    return true;
  }

  /** Remove a peer from a room. Returns true when the peer was a member. */
  leave(room: string, peerId: string): boolean {
    const members = this.rooms.get(room);
    if (!members) return false;
    const removed = members.delete(peerId);
    if (members.size === 0) this.rooms.delete(room);
    return removed;
  }

  /** Remove a peer from every room it is in. Returns the rooms it left. */
  leaveAll(peerId: string): string[] {
    const left: string[] = [];
    for (const [room, members] of this.rooms) {
      if (members.delete(peerId)) {
        left.push(room);
        if (members.size === 0) this.rooms.delete(room);
      }
    }
    return left;
  }

  isMember(room: string, peerId: string): boolean {
    return this.rooms.get(room)?.has(peerId) ?? false;
  }

  getPeer(room: string, peerId: string): PeerInfo | undefined {
    return this.rooms.get(room)?.get(peerId);
  }

  /** Peer ids of the other members of a room. */
  peersIn(room: string, exceptPeerId?: string): string[] {
    const members = this.rooms.get(room);
    if (!members) return [];
    return [...members.keys()].filter((id) => id !== exceptPeerId);
  }

  roomCount(): number {
    return this.rooms.size;
  }

  peerCount(): number {
    let total = 0;
    for (const members of this.rooms.values()) total += members.size;
    return total;
  }

  roomsSnapshot(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [room, members] of this.rooms) out[room] = [...members.keys()];
    return out;
  }
}
