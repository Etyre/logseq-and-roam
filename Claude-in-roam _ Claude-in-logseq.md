Claude-in-roam / Claude-in-logseq

&nbsp;

I want to build a feature that allows the user to call claude in roam (and the analogous feature for logseq).

&nbsp;

The trigger should be a slash command /claude, or alternatively, the page reference \[\[claude in roam\]\].

&nbsp;

When the user puts either of those in a block, the whole tree of parents is given to claude as context. It replaces the line where the trigger is called with “\[\[claude in roam\]\]:” and fills the children of that block with the response from claude in the following format:

&nbsp;

* context  
  * context  
    * context  
      * \[\[claude in roam\]\]:  
        * \=\>  
          * claude response  
          * claude response  
          * claude response  
            * bullet in claude response  
            * bullet in claude response  
          * claude response

&nbsp;

Bullets in the claude response are appropriately nested indented.&nbsp;

&nbsp;

The user can make a new bullet after the claude response, at the same level as the “=\>”, and type a new “user” message. If they hit enter, that will call the model again, This way the user can have an extended conversation with claude in roam.

&nbsp;

* context  
  * context  
    * context  
      * \[\[claude in roam\]\]:  
        * \=\>  
          * claude response  
          * claude response  
          * claude response  
            * bullet in claude response  
            * bullet in claude response  
          * claude response  
        * user follow up  
          * claude response  
          * claude response  
          * claude respons  
        * user followup  
          * claude response  
          * claude response  
          * claude respons  
          * claude response  
          * claude response  
          * claude respons

&nbsp;

If possible render the responses as they arrive, so that the first block fills in, then the second block then the third block, instead of waiting for whole response to return.&nbsp;

&nbsp;

Claude responses are styled distinctly from user written content so that they are visually distinct at a glance.

&nbsp;

Build this in whatever was makes it lowest friction for you, claude code, to update this feature, which might be an addon or a roam/js block.

&nbsp;

The model should be opus. effort: low. web search allowed.&nbsp;