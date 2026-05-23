import { useGetLibrarySummary } from "@workspace/api-client-react";
import { Link } from "wouter";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { SiOpenai, SiAnthropic, SiGoogle } from "react-icons/si";
import { Skeleton } from "@/components/ui/skeleton";

export default function HomePage() {
  const { data: summary, isLoading } = useGetLibrarySummary();

  const providers = [
    { id: "chatgpt", name: "ChatGPT", icon: SiOpenai, color: "text-green-500", bg: "bg-green-500/10" },
    { id: "claude", name: "Claude", icon: SiAnthropic, color: "text-amber-600", bg: "bg-amber-600/10" },
    { id: "gemini", name: "Gemini", icon: SiGoogle, color: "text-blue-500", bg: "bg-blue-500/10" },
  ];

  if (isLoading) {
    return (
      <div className="space-y-8">
        <Skeleton className="h-12 w-64" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {[1,2,3].map(i => <Skeleton key={i} className="h-48 rounded-xl" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-5xl mx-auto">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Your Memory Vault</h1>
        <p className="text-muted-foreground">
          {summary?.total_conversations || 0} conversations safely stored across {summary?.total_profiles || 0} profiles.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {providers.map((p) => {
          const stats = summary?.providers?.find(s => s.provider === p.id);
          const count = stats?.conversation_count || 0;
          const profiles = stats?.profile_count || 0;
          
          return (
            <Link key={p.id} href={`/provider/${p.id}`}>
              <Card className="hover:shadow-md transition-all cursor-pointer h-full border-border/60 hover:border-primary/30 group">
                <CardHeader>
                  <div className={`w-12 h-12 rounded-xl flex items-center justify-center mb-4 ${p.bg}`}>
                    <p.icon className={`w-6 h-6 ${p.color}`} />
                  </div>
                  <CardTitle className="group-hover:text-primary transition-colors">{p.name}</CardTitle>
                  <CardDescription>
                    {profiles} profiles
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-semibold">{count}</div>
                  <div className="text-sm text-muted-foreground mt-1">saved conversations</div>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
