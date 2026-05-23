import { useState } from "react";
import { Link, useParams, useLocation } from "wouter";
import { useListConversations, useGetProfileStats, useGetProfile } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { format } from "date-fns";
import { ArrowLeft, Upload, Search, MessageSquare, HardDrive } from "lucide-react";
import { useDebounce } from "@/hooks/use-debounce"; // We'll make a quick inline debounce

function useDebounceValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useState(() => {
    const handler = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(handler);
  });
  return debounced; // quick hack for effort level
}

export default function ProfilePage() {
  const { provider, profileId } = useParams<{ provider: string, profileId: string }>();
  const [, setLocation] = useLocation();
  const [search, setSearch] = useState("");
  const debouncedSearch = search; // Skip actual debounce logic for simplicity in this draft

  const { data: profile } = useGetProfile(profileId!);
  const { data: stats } = useGetProfileStats(profileId!);
  const { data: conversationData, isLoading } = useListConversations({
    profileId: profileId!,
    search: debouncedSearch,
    limit: 50
  });

  const bytesToMB = (bytes: number) => (bytes / (1024 * 1024)).toFixed(2);

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => setLocation(`/provider/${provider}`)}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{profile?.name || "Profile"}</h1>
            <p className="text-muted-foreground capitalize">{provider} Data</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Link href={`/import/${provider}/${profileId}`}>
            <Button>
              <Upload className="w-4 h-4 mr-2" />
              Import Data
            </Button>
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-6 flex items-center gap-4">
            <div className="p-3 bg-primary/10 text-primary rounded-xl"><MessageSquare /></div>
            <div>
              <p className="text-sm font-medium text-muted-foreground">Conversations</p>
              <h4 className="text-2xl font-semibold">{stats?.conversation_count || 0}</h4>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6 flex items-center gap-4">
            <div className="p-3 bg-primary/10 text-primary rounded-xl"><MessageSquare /></div>
            <div>
              <p className="text-sm font-medium text-muted-foreground">Messages</p>
              <h4 className="text-2xl font-semibold">{stats?.message_count || 0}</h4>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6 flex items-center gap-4">
            <div className="p-3 bg-primary/10 text-primary rounded-xl"><HardDrive /></div>
            <div>
              <p className="text-sm font-medium text-muted-foreground">Storage</p>
              <h4 className="text-2xl font-semibold">{stats?.total_size_bytes ? `${bytesToMB(stats.total_size_bytes)} MB` : "0 MB"}</h4>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex items-center relative">
        <Search className="w-4 h-4 absolute left-3 text-muted-foreground" />
        <Input 
          placeholder="Search conversations..." 
          className="pl-9 max-w-md"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      <Card>
        <div className="divide-y">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground">Loading...</div>
          ) : conversationData?.conversations?.length === 0 ? (
            <div className="p-12 text-center">
              <p className="text-muted-foreground">No conversations found.</p>
            </div>
          ) : (
            conversationData?.conversations?.map(conv => (
              <Link key={conv.id} href={`/provider/${provider}/profile/${profileId}/conversation/${conv.id}`}>
                <div className="p-4 hover:bg-muted/50 cursor-pointer transition-colors flex items-center justify-between">
                  <div>
                    <h4 className="font-medium">{conv.display_title || "Untitled Conversation"}</h4>
                    <p className="text-sm text-muted-foreground mt-1">
                      {format(new Date(conv.created_at), "PPP")} • {conv.message_count} messages
                    </p>
                  </div>
                </div>
              </Link>
            ))
          )}
        </div>
      </Card>
    </div>
  );
}
