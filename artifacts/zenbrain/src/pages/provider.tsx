import { useState } from "react";
import { Link, useParams, useLocation } from "wouter";
import { useListProfiles, useCreateProfile } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { format } from "date-fns";
import { Folder, Plus, ArrowLeft } from "lucide-react";

export default function ProviderPage() {
  const { provider } = useParams<{ provider: string }>();
  const [, setLocation] = useLocation();
  const { data: profiles, isLoading, refetch } = useListProfiles({ provider });
  const createProfile = useCreateProfile();
  
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    
    await createProfile.mutateAsync({
      data: { provider: provider!, name }
    });
    setOpen(false);
    setName("");
    refetch();
  };

  return (
    <div className="space-y-8 max-w-4xl mx-auto">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => setLocation("/")}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight capitalize">{provider} Profiles</h1>
          <p className="text-muted-foreground">Manage your exported data profiles</p>
        </div>
      </div>

      <div className="flex justify-end">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="w-4 h-4 mr-2" />
              New Profile
            </Button>
          </DialogTrigger>
          <DialogContent>
            <form onSubmit={handleCreate}>
              <DialogHeader>
                <DialogTitle>Create Profile</DialogTitle>
              </DialogHeader>
              <div className="py-4 space-y-4">
                <div className="space-y-2">
                  <Label>Profile Name</Label>
                  <Input 
                    value={name} 
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Work Account, Personal"
                    autoFocus
                  />
                </div>
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={!name.trim() || createProfile.isPending}>
                  {createProfile.isPending ? "Creating..." : "Create"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="grid gap-4">
          <Card className="h-24 animate-pulse bg-muted/50" />
        </div>
      ) : profiles?.length === 0 ? (
        <div className="text-center py-16 bg-muted/20 rounded-xl border border-dashed">
          <Folder className="w-12 h-12 text-muted-foreground/50 mx-auto mb-4" />
          <h3 className="text-lg font-medium">No profiles yet</h3>
          <p className="text-muted-foreground mb-4">Create a profile to start importing your data.</p>
          <Button onClick={() => setOpen(true)} variant="outline">Create Profile</Button>
        </div>
      ) : (
        <div className="grid gap-4">
          {profiles?.map((profile) => (
            <Link key={profile.id} href={`/provider/${provider}/profile/${profile.id}`}>
              <Card className="hover:border-primary/50 cursor-pointer transition-colors">
                <CardContent className="p-6 flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center text-primary">
                      <Folder className="w-5 h-5" />
                    </div>
                    <div>
                      <h3 className="font-medium text-lg">{profile.name}</h3>
                      <p className="text-sm text-muted-foreground">
                        {profile.conversation_count || 0} conversations
                        {profile.last_import_at && ` • Last import ${format(new Date(profile.last_import_at), "MMM d, yyyy")}`}
                      </p>
                    </div>
                  </div>
                  <Button variant="ghost">View</Button>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
