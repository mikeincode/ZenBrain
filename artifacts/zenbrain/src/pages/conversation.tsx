import { useState } from "react";
import { Link, useParams, useLocation } from "wouter";
import { useGetConversation, useUpdateConversation } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowLeft, Download, Edit2, Check } from "lucide-react";

export default function ConversationPage() {
  const { provider, profileId, conversationId } = useParams<{ provider: string, profileId: string, conversationId: string }>();
  const [, setLocation] = useLocation();
  const { data: conv, isLoading, refetch } = useGetConversation(conversationId!);
  const updateConv = useUpdateConversation();
  
  const [isEditing, setIsEditing] = useState(false);
  const [title, setTitle] = useState("");

  const handleEdit = () => {
    setTitle(conv?.display_title || "");
    setIsEditing(true);
  };

  const handleSave = async () => {
    if (title.trim() && title !== conv?.display_title) {
      await updateConv.mutateAsync({
        conversationId: conversationId!,
        data: { display_title: title }
      });
      refetch();
    }
    setIsEditing(false);
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-4 mb-8">
        <Button variant="ghost" size="icon" onClick={() => setLocation(`/provider/${provider}/profile/${profileId}`)}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="flex-1 flex items-center gap-3">
          {isEditing ? (
            <div className="flex items-center gap-2 w-full max-w-md">
              <Input 
                value={title} 
                onChange={e => setTitle(e.target.value)} 
                autoFocus 
                onKeyDown={e => e.key === 'Enter' && handleSave()}
              />
              <Button size="icon" onClick={handleSave}><Check className="w-4 h-4" /></Button>
            </div>
          ) : (
            <>
              <h1 className="text-2xl font-semibold tracking-tight">{conv?.display_title || "Untitled Conversation"}</h1>
              <Button variant="ghost" size="icon" onClick={handleEdit} className="text-muted-foreground hover:text-foreground">
                <Edit2 className="w-4 h-4" />
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="bg-card border rounded-xl p-6 md:p-8 min-h-[500px] shadow-sm">
        {isLoading ? (
          <div className="animate-pulse space-y-4">
            <div className="h-4 bg-muted rounded w-3/4"></div>
            <div className="h-4 bg-muted rounded w-1/2"></div>
            <div className="h-4 bg-muted rounded w-5/6"></div>
          </div>
        ) : (
          <div className="prose prose-blue dark:prose-invert max-w-none">
            {/* Minimal basic render instead of full react-markdown to ensure it works */}
            <div dangerouslySetInnerHTML={{ __html: (conv as any)?.markdown_content?.replace(/\n/g, '<br/>') || "No content available." }} />
          </div>
        )}
      </div>
    </div>
  );
}
